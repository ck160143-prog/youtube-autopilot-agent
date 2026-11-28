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

// Sessions are keyed by a hash of the cookie value, never by the value itself.
function sessionKey(id) {
  return crypto.createHash("sha256").update(String(id)).digest("hex");
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

// Where the owner's identity lives decides whether owner-only access means
// anything. On an ephemeral filesystem (Render's free tier) users.json is wiped
// on every deploy; the instance then has no owner, and "the first account is the
// owner" would hand the whole instance to whoever loads the page next. So the
// app must know whether its data survives a restart, and refuse to operate when
// it does not.
function isEphemeralPath(target) {
  const resolved = path.resolve(String(target || ""));
  const tmpRoots = ["/tmp", "/var/tmp", "/dev/shm"];
  if (tmpRoots.some(root => resolved === root || resolved.startsWith(root + path.sep))) return true;
  // Undeclared DATA_DIR means "inside the app directory", which is exactly what
  // a container replaces on deploy.
  if (!process.env.DATA_DIR) return true;
  return false;
}

// Reported on /api/auth/status and enforced on every private route. It is a
// statement about the filesystem, not a guess: the path is checked for a real
// directory, and anything under a temp root or the app directory is ephemeral.
function storageState(dataDir) {
  const dir = path.resolve(String(dataDir || ""));
  const ephemeralPath = isEphemeralPath(dir);
  let writable = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    writable = true;
  } catch (_) {
    writable = false;
  }
  const durable = writable && !ephemeralPath;
  // The requirement is enforced where it matters: a production deployment, or a
  // Render instance (whose RENDER env var is set by the platform). Local runs and
  // the test suite are not blocked, because there is nothing to lose there.
  const required = process.env.NODE_ENV === "production" || process.env.RENDER === "true" ||
    /^(1|true|yes|on)$/i.test(String(process.env.OWNER_REQUIRE_PERSISTENT_STORAGE || ""));
  return {
    dir,
    writable,
    ephemeralPath,
    durable,
    required,
    // Fail closed only when persistence matters and is missing.
    blocksAccess: required && !durable,
    reason: durable
      ? "DATA_DIR एक स्थिर disk पर है।"
      : (ephemeralPath
        ? "DATA_DIR स्थिर नहीं है (ephemeral): deploy/restart पर owner account मिट जाएगा। DATA_DIR को attached Render Disk पर सेट करें।"
        : "DATA_DIR लिखने योग्य नहीं है।"),
  };
}

class AuthStore {
  constructor(options = {}) {
    this.dir = options.dir || path.join(process.cwd(), "data");
    this.usersFile = path.join(this.dir, "users.json");
    this.sessionsFile = path.join(this.dir, "sessions.json");
    this.users = [];
    this.sessions = {};
    this.dataDir = this.dir;
  }

  // An explicit, one-time secret is the only way to create the owner. Without
  // it there is no owner and no way to become one — never "the first visitor".
  bootstrapToken() {
    return String(process.env.OWNER_BOOTSTRAP_TOKEN || "");
  }

  bootstrapTokenUsable() {
    const token = this.bootstrapToken();
    // A short token is a guessable token; a guessable token is the takeover bug
    // in a different disguise, so it is treated as "not configured".
    return token.length >= 16;
  }

  storage() {
    return storageState(this.dataDir);
  }

  // True only when the owner can still legitimately be created: no owner yet,
  // a real token configured, and identity that will actually persist.
  canBootstrap() {
    return !this.hasOwner() && this.bootstrapTokenUsable() && !this.storage().blocksAccess;
  }

  // Fail-closed gate for every private route. Two conditions stop the instance
  // instead of serving it: no owner exists (nobody may be admitted until one
  // does), or the filesystem cannot keep an owner.
  accessBlock() {
    const storage = this.storage();
    if (storage.blocksAccess) {
      return { code: "PERSISTENT_STORAGE_REQUIRED", message: storage.reason };
    }
    if (!this.hasOwner()) {
      return {
        code: "OWNER_NOT_CONFIGURED",
        message: this.bootstrapTokenUsable()
          ? "Owner अभी बना नहीं है। पहला owner सिर्फ OWNER_BOOTSTRAP_TOKEN से बनता है।"
          : "Owner अभी बना नहीं है और OWNER_BOOTSTRAP_TOKEN सेट नहीं है, इसलिए access बंद है।",
      };
    }
    return null;
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
    for (const [key, session] of Object.entries(this.sessions)) {
      // Older builds keyed sessions by the raw id. Those keys are not hashes, so
      // they can never match a lookup again; dropping them is the honest choice
      // (the user signs in once more) and removes a replayable credential from
      // the file the moment the new build starts.
      if (!session || Number(session.expiresAt) < now || !/^[a-f0-9]{64}$/.test(key)) {
        delete this.sessions[key];
      }
    }
    return this;
  }

  // Both files hold credentials (password hashes, live session ids), so they are
  // created owner-only instead of the default 0644.
  writePrivate(file, data) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  }

  saveUsers() {
    this.writePrivate(this.usersFile, JSON.stringify({ version: 1, users: this.users }, null, 2));
  }

  saveSessions() {
    this.writePrivate(this.sessionsFile, JSON.stringify({ version: 2, sessions: this.sessions }, null, 2));
  }

  userCount() {
    return this.users.length;
  }

  // Is there an owner yet? Until there is, the instance cannot be private.
  hasOwner() {
    return this.users.some(user => user.role === "owner");
  }

  ownerId() {
    const owner = this.users.find(user => user.role === "owner");
    return owner ? owner.id : null;
  }

  // Never reveals how many accounts exist or who they are: only whether a door
  // exists, and which one.
  signupState() {
    const openSignup = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_PUBLIC_SIGNUP || ""));
    return {
      bootstrap: this.canBootstrap(),
      openSignup,
      // "registration open" is only true for a door that a newcomer could use;
      // the owner door needs a secret nobody is given here.
      registrationOpen: this.canBootstrap() || openSignup,
    };
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
  register({ username, password, registrationKey, bootstrapToken }) {
    const name = String(username || "").trim();
    // Owner-only private access, with an explicit owner bootstrap.
    //
    // The owner exists only if someone presents OWNER_BOOTSTRAP_TOKEN. Being the
    // first visitor, being the first row in an empty users.json after a redeploy,
    // or knowing the registration key must never be enough: on an ephemeral disk
    // "first account wins" means "the next stranger owns everything".
    //
    //   owner bootstrap  -> requires the one-time token, refused afterwards,
    //                       and refused when identity would not survive a restart.
    //   later accounts   -> only when an operator opened signup, and always
    //                       members, never owners.
    const hasOwnerYet = this.hasOwner();
    const token = this.bootstrapToken();
    const bootstrap = !hasOwnerYet && Boolean(token) && safeEqual(bootstrapToken, token);
    if (!hasOwnerYet && !bootstrap) {
      // Either no token is configured, or the wrong one was given. The message
      // does not say which, so it cannot be used to probe the instance.
      throw Object.assign(new Error(
        "Owner bootstrap के लिए सही OWNER_BOOTSTRAP_TOKEN जरूरी है। इसके बिना कोई account नहीं बन सकता।"
      ), { statusCode: 403, code: "OWNER_BOOTSTRAP_REQUIRED" });
    }
    if (hasOwnerYet === false && token && !this.bootstrapTokenUsable()) {
      throw Object.assign(new Error(
        "OWNER_BOOTSTRAP_TOKEN कम से कम 16 अक्षर का होना चाहिए।"
      ), { statusCode: 503, code: "WEAK_BOOTSTRAP_TOKEN" });
    }
    if (bootstrap) {
      if (!this.bootstrapTokenUsable()) {
        throw Object.assign(new Error(
          "OWNER_BOOTSTRAP_TOKEN कम से कम 16 अक्षर का होना चाहिए।"
        ), { statusCode: 503, code: "WEAK_BOOTSTRAP_TOKEN" });
      }
      const storage = this.storage();
      if (storage.blocksAccess) {
        throw Object.assign(new Error(storage.reason), {
          statusCode: 503, code: "PERSISTENT_STORAGE_REQUIRED",
        });
      }
    }
    const openSignup = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_PUBLIC_SIGNUP || ""));
    const required = String(process.env.APP_REGISTRATION_KEY || "");
    // A door has been opened at this point (bootstrap token or operator-opened
    // signup), so the ordinary validation may now run and answer honestly. It
    // deliberately runs after the door check: otherwise a wrong token would get a
    // different answer from a right one and the token could be guessed.
    if (!USERNAME_RE.test(name)) {
      throw Object.assign(new Error("Username 3-32 अक्षर (a-z, 0-9, _) का हो।"), { statusCode: 400 });
    }
    if (String(password || "").length < 8) {
      throw Object.assign(new Error("Password कम से कम 8 अक्षर का हो।"), { statusCode: 400 });
    }
    if (this.findByUsername(name)) {
      throw Object.assign(new Error("यह username पहले से है।"), { statusCode: 409 });
    }
    if (!bootstrap && !openSignup) {
      throw Object.assign(new Error(
        "Public signup बंद है (Owner-only access)। नया account सिर्फ मालिक खोल सकता है।"
      ), { statusCode: 403, code: "SIGNUP_CLOSED" });
    }
    if (!bootstrap && openSignup && required && !safeEqual(registrationKey, required)) {
      throw Object.assign(new Error("Registration key जरूरी है।"), { statusCode: 403 });
    }
    // A new bootstrap token is issued for the request that just used one: the
    // caller stores it in the environment, so the same value cannot be replayed
    // against a wiped instance by whoever happens to read this response.
    const nextBootstrapToken = bootstrap ? crypto.randomBytes(32).toString("base64url") : null;
    const user = {
      id: "u" + crypto.randomBytes(8).toString("hex"),
      // The owner is created only by the bootstrap token; everyone else is a
      // member, even when signup was opened.
      role: bootstrap ? "owner" : "member",
      username: name,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
      ...(bootstrap ? { bootstrappedAt: new Date().toISOString() } : {}),
    };
    this.users.push(user);
    this.saveUsers();
    const created = this.getUser(user.id);
    // nextBootstrapToken is returned only to the caller that just proved it holds
    // the current token, so it can rotate the environment variable.
    return nextBootstrapToken ? { ...created, nextBootstrapToken } : created;
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

  // The session id is a bearer credential: whoever holds it is the user. Only a
  // SHA-256 of it is stored, so the file on disk cannot be replayed as a cookie —
  // measured before this change: copying the stored id into a Cookie header
  // returned 200 as the owner.
  createSession(userId) {
    const id = crypto.randomBytes(32).toString("base64url");
    const session = {
      userId,
      csrfToken: crypto.randomBytes(24).toString("base64url"),
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions[sessionKey(id)] = session;
    this.saveSessions();
    // The raw id goes to the cookie; it is never written to disk.
    return { ...session, id };
  }

  getSession(id) {
    if (!id) return null;
    const key = sessionKey(id);
    const session = this.sessions[key];
    if (!session) return null;
    if (Number(session.expiresAt) < Date.now()) {
      delete this.sessions[key];
      this.saveSessions();
      return null;
    }
    return session;
  }

  destroySession(id) {
    const key = sessionKey(id);
    if (!this.sessions[key]) return false;
    delete this.sessions[key];
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

// Owner-only access: the account must exist, be the owner, and the instance must
// still have an owner. This is the gate on every private route.
function requireOwner(req, res, next) {
  if (!req.user) return requireAuth(req, res, next);
  if (req.user.role !== "owner") {
    return res.status(403).json({
      error: "यह instance owner-only है। सिर्फ मालिक का account access कर सकता है।",
      code: "OWNER_ONLY",
    });
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
  OWNER_ROLE: "owner",
  csrfMiddleware,
  safeEqual,
  sessionKey,
  storageState,
  isEphemeralPath,
};
