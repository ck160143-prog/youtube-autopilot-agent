"use strict";

// Security middleware loaded before server.js via npm start and npm test.
// Keeps the existing Express routes and provider integrations intact.
const crypto = require("node:crypto");
const originalExpress = require("express");
const jobCapabilities = new Map();
const rateBuckets = new Map();
const WINDOW_MS = 60 * 1000;

function cookieValue(req, name) {
  const prefix = name + "=";
  const entry = String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requestRateLimit(req, res) {
  if (!req.path.startsWith("/api/")) return false;
  const now = Date.now();
  if (rateBuckets.size > 5000) {
    for (const [key, bucket] of rateBuckets) if (now - bucket.startedAt > WINDOW_MS) rateBuckets.delete(key);
  }
  const routeGroup = /^\/api\/(?:script|seo|images|voice)(?:\/|$)/.test(req.path) ? "ai" :
    /^\/api\/youtube\/upload$/.test(req.path) ? "upload" :
      /^\/api\/render(?:\/|$)/.test(req.path) ? "render" : "general";
  const limits = { ai: 20, upload: 5, render: 10, general: 120 };
  const configured = Number(process.env.API_RATE_LIMIT_MAX);
  const max = Number.isInteger(configured) && configured > 0 ? Math.min(configured, 1000) : limits[routeGroup];
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const key = routeGroup + ":" + ip;
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  res.setHeader("RateLimit-Limit", String(max));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
  if (bucket.count > max) {
    res.setHeader("Retry-After", String(Math.ceil((WINDOW_MS - (now - bucket.startedAt)) / 1000)));
    jsonError(res, 429, "Request limit exceeded. Wait before retrying.");
    return true;
  }
  return false;
}

function validateVideoSignature(body, mime) {
  if (!Buffer.isBuffer(body) || body.length < 12) return false;
  if (mime === "video/webm") return body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === "video/mp4" || mime === "video/quicktime") return body.toString("ascii", 4, 8) === "ftyp";
  return false;
}

function validateImageSignature(scene) {
  if (!scene || typeof scene.imageBase64 !== "string") return false;
  const bytes = Buffer.from(scene.imageBase64, "base64");
  const mime = String(scene.mimeType || "").toLowerCase();
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

function protectRenderRoute(method, routePath, handler) {
  if (method === "post" && routePath === "/api/render") {
    return function renderOwnerCreation(req, res, next) {
      if (!req.body || !Array.isArray(req.body.scenes) || !req.body.scenes.every(validateImageSignature)) {
        return jsonError(res, 400, "Scene image content does not match an allowed PNG, JPEG, or WebP format.");
      }
      const audioMime = String(req.body.audioMime || "audio/L16").toLowerCase();
      if (audioMime.includes("wav")) {
        const audio = Buffer.from(String(req.body.audioBase64 || ""), "base64");
        if (audio.length < 12 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
          return jsonError(res, 400, "Audio content does not match the declared WAV format.");
        }
      }
      const capability = crypto.randomBytes(32).toString("base64url");
      const originalJson = res.json.bind(res);
      res.json = body => {
        if (res.statusCode === 202 && body && typeof body.jobId === "string") {
          jobCapabilities.set(body.jobId, capability);
          const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
          res.setHeader("Set-Cookie", "baba_render_capability=" + capability + "; Path=/api/render; HttpOnly; SameSite=Strict; Max-Age=600" + secure);
        }
        return originalJson(body);
      };
      return handler(req, res, next);
    };
  }

  if (method === "get" && (routePath === "/api/render/status/:jobId" || routePath === "/api/render/download/:jobId")) {
    return function renderOwnerCheck(req, res, next) {
      const expected = jobCapabilities.get(req.params.jobId);
      if (!expected) return handler(req, res, next);
      const supplied = cookieValue(req, "baba_render_capability");
      if (!supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        return jsonError(res, 403, "You are not authorized to access this render job.");
      }
      if (routePath === "/api/render/download/:jobId") {
        res.once("finish", () => setTimeout(() => jobCapabilities.delete(req.params.jobId), 1000).unref());
      }
      return handler(req, res, next);
    };
  }

  if (method === "post" && routePath === "/api/youtube/upload") {
    return function validateUpload(req, res, next) {
      const mime = String(req.headers["content-type"] || "video/mp4").split(";")[0].toLowerCase();
      if (!validateVideoSignature(req.body, mime)) {
        return jsonError(res, 415, "Video bytes do not match an allowed MP4, MOV, or WebM signature.");
      }
      const privacy = String(req.headers["x-video-privacy"] || "private").toLowerCase();
      if (privacy === "public" && req.headers["x-public-upload-confirmation"] !== "CONFIRM_PUBLIC_UPLOAD") {
        return jsonError(res, 428, "Public publishing needs explicit confirmation. Confirm this exact public upload before retrying.");
      }
      return handler(req, res, next);
    };
  }
  return handler;
}

function makeHardenedExpress(...args) {
  const app = originalExpress(...args);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://upload.wikimedia.org; media-src 'self' blob:; connect-src 'self'; upgrade-insecure-requests");
    if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    const method = req.method.toUpperCase();
    const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    const origin = req.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== req.get("host")) return jsonError(res, 403, "Cross-origin request rejected.");
      } catch (_) {
        return jsonError(res, 403, "Invalid request origin.");
      }
    } else if (unsafe && /(?:^|;\\s*)(?:baba_youtube_session|baba_render_capability)=/.test(req.headers.cookie || "")) {
      return jsonError(res, 403, "Origin is required for cookie-authenticated state changes.");
    }
    if (unsafe && req.get("sec-fetch-site") === "cross-site") return jsonError(res, 403, "Cross-site state change rejected.");
    if (requestRateLimit(req, res)) return;
    next();
  });

  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const register = app[method].bind(app);
    app[method] = (routePath, ...handlers) => {
      if (typeof routePath !== "string" || handlers.length === 0) return register(routePath, ...handlers);
      const wrapped = handlers.map((handler, index) => {
        if (typeof handler !== "function") return handler;
        // Body parsers stay in their original route position; hardening wraps the terminal handler.
        if (index !== handlers.length - 1) return handler;
        return protectRenderRoute(method, routePath, handler);
      });
      return register(routePath, ...wrapped);
    };
  }
  return app;
}

Object.assign(makeHardenedExpress, originalExpress);
makeHardenedExpress.Router = originalExpress.Router;
makeHardenedExpress.json = originalExpress.json;
makeHardenedExpress.raw = originalExpress.raw;
makeHardenedExpress.static = originalExpress.static;
makeHardenedExpress.urlencoded = originalExpress.urlencoded;
require.cache[require.resolve("express")].exports = makeHardenedExpress;

module.exports = {
  validateVideoSignature,
  validateImageSignature,
  _resetForTests() { rateBuckets.clear(); jobCapabilities.clear(); }
};
