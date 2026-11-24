"use strict";

// In-memory sliding-window rate limiter. Keyed by user when authenticated, by
// IP otherwise, and by route group so a burst of AI calls cannot starve the
// health check. Memory is bounded: stale buckets are pruned on a timer.

const WINDOW_MS = 60 * 1000;

const GROUPS = {
  ai: { pattern: /^\/api\/(?:script|seo|story|images|voice)/, limit: 20 },
  // Only the expensive POSTs are limited: status/download polling is a cheap
  // read and belongs to the general bucket, or the dashboard would throttle
  // itself while waiting for a render.
  render: { pattern: /^\/api\/(?:render$|projects\/[^/]+\/(?:render|automate|thumbnail)$)/, limit: 10 },
  upload: { pattern: /^\/api\/youtube\/upload/, limit: 5 },
  auth: { pattern: /^\/api\/auth\/(?:login|register)/, limit: 10 },
  general: { pattern: /.*/, limit: 120 },
};

function groupFor(path) {
  for (const [name, group] of Object.entries(GROUPS)) {
    if (name !== "general" && group.pattern.test(path)) return { name, limit: group.limit };
  }
  return { name: "general", limit: GROUPS.general.limit };
}

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || WINDOW_MS;
  const multiplier = Math.max(0.1, Number(options.multiplier) || 1);
  const buckets = new Map();
  let lastPrune = Date.now();

  function prune() {
    const now = Date.now();
    if (now - lastPrune < 30000) return;
    lastPrune = now;
    for (const [key, bucket] of buckets) {
      if (now - bucket.start >= windowMs) buckets.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    // Express trims req.path inside app.use("/api", ...), so rebuild the full
    // path; otherwise every route lands in the "general" bucket.
    const requestPath = String((req && req.baseUrl) || "") + String((req && req.path) || "");
    if (requestPath === "/api/health" || requestPath === "/api/auth/status") return next();
    prune();
    const group = groupFor(requestPath);
    const limit = Math.max(1, Math.round(group.limit * multiplier));
    const subject = (req.user && req.user.id) || req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    const key = group.name + ":" + subject;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      res.setHeader("Retry-After", String(Math.ceil((windowMs - (now - bucket.start)) / 1000)));
      return res.status(429).json({ error: "Request limit reached. Try again shortly.", code: "RATE_LIMITED" });
    }
    return next();
  };
}

module.exports = { createRateLimiter, groupFor, GROUPS, WINDOW_MS };
