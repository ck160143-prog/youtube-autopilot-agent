"use strict";

// Multi-user authentication: users + server-side sessions, scrypt password
// hashing, per-session CSRF tokens. Stored in two JSON files so a restart
// keeps logins alive; sessions are revocable because the id is the only thing
// in the cookie.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SESSION_COOKIE = "baba_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/i;

function readCookie(req, name) {
  const prefix = name + "=";
  const entry = String(req.headers.cookie || "").split(";").map(v => v.trim())
    .find(v => v.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

// Precomputed scrypt hash used only to equalise login timing.
const DUMMY_HASH = hashPassword("baba-ai-timing-equaliser");

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return "scrypt$16384$8$1$" + salt.toString("base64url") + "$" + key.toString("base64url");
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts[0] !== "scrypt") return false;
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function cookieHeader(sessionId, options = {}) {
  const maxAge = options.maxAge == null ? Math.floor(SESSION_TTL_MS / 1000) : options.maxAge;
  const parts = [
    SESSION_COOKIE + "=" + sessionId,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + maxAge,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function clearCookieHeader() {
  return SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" +
    (process.env.NODE_ENV === "production" ? "; Secure" : "");
}

class AuthStore {
  constructor(options = {}) {
    this.dir = options.dir || path.join(process.cwd(), "data");
    this.usersFile = path.join(this.dir, "users.json");
    this.sessionsFile = path.join(this.dir, "sessions.json");
    this.users = [];
    this.sessions = {};
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.usersFile, "utf8"));
      this.users = Array.isArray(parsed.users) ? parsed.users : [];
    } catch (_) { this.users = []; }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionsFile, "utf8"));
      this.sessions = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
    } catch (_) { this.sessions = {}; }
    const now = Date.now();
    for (const [id, session] of Object.entries(this.sessions)) {
      if (!session || Number(session.expiresAt) < now) delete this.sessions[id];
    }
    return this;
  }

  saveUsers() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.usersFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: this.users }, null, 2));
    fs.renameSync(tmp, this.usersFile);
  }

  saveSessions() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.sessionsFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: this.sessions }, null, 2));
    fs.renameSync(tmp, this.sessionsFile);
  }

  userCount() {
    return this.users.length;
  }

  findByUsername(username) {
    const needle = String(username || "").toLowerCase();
    return this.users.find(user => user.username.toLowerCase() === needle) || null;
  }

  getUser(id) {
    const user = this.users.find(item => item.id === id);
    return user ? { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt } : null;
  }

  // Open for the very first user (the owner). Afterwards a registration key is
  // required, so a public URL cannot become an open signup endpoint.
  register({ username, password, registrationKey }) {
    const name = String(username || "").trim();
    if (!USERNAME_RE.test(name)) {
      throw Object.assign(new Error("Username 3-32 अक्षर (a-z, 0-9, _) का हो।"), { statusCode: 400 });
    }
    if (String(password || "").length < 8) {
      throw Object.assign(new Error("Password कम से कम 8 अक्षर का हो।"), { statusCode: 400 });
    }
    if (this.findByUsername(name)) {
      throw Object.assign(new Error("यह username पहले से है।"), { statusCode: 409 });
    }
    const open = this.users.length === 0;
    const required = process.env.APP_REGISTRATION_KEY || "";
    if (!open && !required) {
      throw Object.assign(new Error("Registration बंद है। नया account जोड़ने के लिए APP_REGISTRATION_KEY सेट करें।"), { statusCode: 403 });
    }
    if (!open && required && !safeEqual(registrationKey, required)) {
      throw Object.assign(new Error("Registration key जरूरी है।"), { statusCode: 403 });
    }
    const user = {
      id: "u" + crypto.randomBytes(8).toString("hex"),
      username: name,
      passwordHash: hashPassword(password),
      role: open ? "owner" : "member",
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    this.saveUsers();
    return this.getUser(user.id);
  }

  login(username, password) {
    const user = this.findByUsername(username);
    // Verify against a dummy hash when the username is unknown so response time
    // does not reveal whether an account exists.
    const hash = user ? user.passwordHash : DUMMY_HASH;
    const ok = verifyPassword(password, hash);
    if (!user || !ok) {
      throw Object.assign(new Error("Username या password गलत है।"), { statusCode: 401 });
    }
    return this.createSession(user.id);
  }

  createSession(userId) {
    const id = crypto.randomBytes(32).toString("base64url");
    const session = {
      id,
      userId,
      csrfToken: crypto.randomBytes(24).toString("base64url"),
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions[id] = session;
    this.saveSessions();
    return session;
  }

  getSession(id) {
    const session = this.sessions[id];
    if (!session) return null;
    if (Number(session.expiresAt) < Date.now()) {
      delete this.sessions[id];
      this.saveSessions();
      return null;
    }
    return session;
  }

  destroySession(id) {
    if (!this.sessions[id]) return false;
    delete this.sessions[id];
    this.saveSessions();
    return true;
  }
}

function sessionMiddleware(store) {
  return (req, res, next) => {
    const id = readCookie(req, SESSION_COOKIE);
    if (id) {
      const session = store.getSession(id);
      if (session) {
        req.session = session;
        req.user = store.getUser(session.userId);
      }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Login जरूरी है।", code: "AUTH_REQUIRED" });
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.user) return requireAuth(req, res, next);
  const project = req.project;
  if (!project) return res.status(404).json({ error: "प्रोजेक्ट नहीं मिला।" });
  if (project.ownerId && project.ownerId !== req.user.id) {
    return res.status(403).json({ error: "यह प्रोजेक्ट आपका नहीं है।", code: "FORBIDDEN" });
  }
  next();
}

// CSRF: unsafe methods need the session token, or a same-origin signal. A
// cross-site form post cannot read the token and cannot set a custom header.
function csrfMiddleware() {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (!req.session) return next(); // unauthenticated: requireAuth answers 401
    // A cross-site Origin is rejected even when a token is present: no legitimate
    // request carries both, and it keeps a leaked token from being replayable
    // from another site.
    const origin = req.get("origin");
    if (origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(origin).host === req.get("host"); } catch (_) { sameOrigin = false; }
      if (!sameOrigin) return res.status(403).json({ error: "CSRF validation विफल (origin)।", code: "CSRF" });
      return next();
    }
    const supplied = req.get("x-csrf-token");
    if (supplied && safeEqual(supplied, req.session.csrfToken)) return next();
    if (req.get("sec-fetch-site") === "same-origin") return next();
    return res.status(403).json({ error: "CSRF validation विफल।", code: "CSRF" });
  };
}

module.exports = {
  AuthStore,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  readCookie,
  cookieHeader,
  clearCookieHeader,
  hashPassword,
  verifyPassword,
  sessionMiddleware,
  requireAuth,
  requireOwner,
  csrfMiddleware,
  safeEqual,
};
