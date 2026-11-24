"use strict";

// Persistent job queue. Job metadata lives in one JSON file; large payloads
// (base64 scene images for the Phase 1 render API) live in their own file so a
// status update never rewrites megabytes of image data. Every state change is
// written atomically (temp file + rename) so a crash cannot corrupt the queue.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const INLINE_PAYLOAD_LIMIT = 256 * 1024;

function atomicWrite(file, data) {
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

class JobQueue {
  constructor(options = {}) {
    this.dir = options.dir;
    if (!this.dir) throw new Error("JobQueue को dir चाहिए।");
    this.file = path.join(this.dir, options.filename || "jobs.json");
    this.maxJobs = options.maxJobs || 200;
    this.jobs = new Map();
    this.handlers = new Map();
    this.running = false;
    this.activeJobId = null;
    this._timer = null;
    this.logger = options.logger || (line => console.log("[jobs] " + line));
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
    return this;
  }

  load() {
    this.ensureDir();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.jobs) ? parsed.jobs : []);
      for (const raw of list) {
        if (!raw || !raw.id) continue;
        this.jobs.set(raw.id, raw);
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.logger("queue load failed: " + error.message);
    }
    return this;
  }

  save() {
    this.ensureDir();
    const list = Array.from(this.jobs.values()).map(job => {
      // Payloads big enough to live on disk are referenced, never inlined.
      const copy = Object.assign({}, job);
      if (copy.payloadStored) {
        delete copy.payload;
      }
      return copy;
    });
    try {
      atomicWrite(this.file, JSON.stringify({ version: 1, savedAt: nowIso(), jobs: list }, null, 0));
    } catch (error) {
      this.logger("queue save failed: " + error.message);
    }
  }

  payloadFile(id) {
    return path.join(this.dir, "payload-" + id + ".json");
  }

  writePayload(id, payload) {
    const json = JSON.stringify(payload === undefined ? null : payload);
    if (Buffer.byteLength(json) <= INLINE_PAYLOAD_LIMIT) {
      return { payload: JSON.parse(json), payloadStored: false };
    }
    atomicWrite(this.payloadFile(id), json);
    return { payload: undefined, payloadStored: true };
  }

  readPayload(job) {
    if (!job) return undefined;
    if (job.payloadStored) {
      try {
        return JSON.parse(fs.readFileSync(this.payloadFile(job.id), "utf8"));
      } catch (_) {
        return undefined;
      }
    }
    return job.payload;
  }

  create(input = {}) {
    const id = input.id || ("j" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex"));
    const stored = this.writePayload(id, input.payload);
    const job = {
      id,
      type: String(input.type || "generic"),
      ownerId: input.ownerId ? String(input.ownerId).slice(0, 40) : null,
      projectId: input.projectId ? String(input.projectId).slice(0, 80) : null,
      stage: input.stage ? String(input.stage).slice(0, 40) : null,
      status: "queued",
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(5, Number(input.maxAttempts) || 1)),
      error: null,
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      payloadStored: stored.payloadStored,
    };
    if (!stored.payloadStored) job.payload = stored.payload;
    this.jobs.set(id, job);
    this.prune();
    this.save();
    return this.publicView(job);
  }

  // Mark a job as running right now (used when the caller executes the work in
  // its own process instead of leaving the job for the queue worker). An id of
  // an existing queued job resumes that record instead of duplicating it.
  track(input = {}) {
    const existing = input.id ? this.jobs.get(String(input.id)) : null;
    if (existing) {
      existing.status = "processing";
      existing.attempts = Math.max(1, Number(existing.attempts) || 0);
      existing.startedAt = nowIso();
      existing.updatedAt = nowIso();
      existing.error = null;
      existing.finishedAt = null;
      this.activeJobId = existing.id;
      this.save();
      return this.publicView(existing);
    }
    const created = this.create(Object.assign({}, input, { maxAttempts: input.maxAttempts || 2 }));
    const job = this.jobs.get(created.id);
    job.status = "processing";
    job.startedAt = nowIso();
    job.attempts = 1;
    job.updatedAt = nowIso();
    this.activeJobId = job.id;
    this.save();
    return this.publicView(job);
  }

  get(id) {
    return this.jobs.get(String(id)) || null;
  }

  publicView(job) {
    if (!job) return null;
    const payload = this.readPayload(job);
    return {
      id: job.id, type: job.type, ownerId: job.ownerId, projectId: job.projectId,
      stage: job.stage, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts,
      error: job.error, result: job.result, createdAt: job.createdAt, updatedAt: job.updatedAt,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      payload: payload === undefined ? null : payload,
      resumable: Boolean(job.payloadStored || job.projectId),
    };
  }

  list(filter = {}) {
    return Array.from(this.jobs.values())
      .filter(job => !filter.type || job.type === filter.type)
      .filter(job => !filter.ownerId || job.ownerId === filter.ownerId)
      .filter(job => !filter.projectId || job.projectId === filter.projectId)
      .filter(job => !filter.status || job.status === filter.status)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(job => this.publicView(job));
  }

  update(id, patch) {
    const job = this.jobs.get(String(id));
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: nowIso() });
    this.save();
    return job;
  }

  claimNext() {
    const next = Array.from(this.jobs.values())
      .filter(job => job.status === "queued")
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!next) return null;
    next.status = "processing";
    next.startedAt = nowIso();
    next.attempts = Number(next.attempts || 0) + 1;
    next.updatedAt = nowIso();
    this.activeJobId = next.id;
    this.save();
    return this.publicView(next);
  }

  complete(id, result) {
    const job = this.jobs.get(String(id));
    if (!job) return null;
    job.status = "completed";
    job.result = result === undefined ? null : result;
    job.error = null;
    job.finishedAt = nowIso();
    job.updatedAt = nowIso();
    if (this.activeJobId === job.id) this.activeJobId = null;
    this.save();
    return this.publicView(job);
  }

  fail(id, error, options = {}) {
    const job = this.jobs.get(String(id));
    if (!job) return null;
    const message = typeof error === "string" ? error : (error && error.message) || "काम विफल रहा।";
    if (options.retry && job.attempts < job.maxAttempts) {
      job.status = "queued";
      job.error = message;
      job.updatedAt = nowIso();
      if (this.activeJobId === job.id) this.activeJobId = null;
      this.save();
      return this.publicView(job);
    }
    job.status = "failed";
    job.error = message;
    job.finishedAt = nowIso();
    job.updatedAt = nowIso();
    if (this.activeJobId === job.id) this.activeJobId = null;
    this.save();
    return this.publicView(job);
  }

  cancel(id) {
    const job = this.jobs.get(String(id));
    if (!job) return null;
    if (TERMINAL.has(job.status)) return this.publicView(job);
    job.status = "cancelled";
    job.error = job.error || "उपयोगकर्ता ने रोका।";
    job.finishedAt = nowIso();
    job.updatedAt = nowIso();
    if (this.activeJobId === job.id) this.activeJobId = null;
    this.save();
    return this.publicView(job);
  }

  // Called once at boot: a job that was "processing" when the process died is
  // re-queued when it can actually be resumed (its payload is on disk, or it is
  // a project stage that rebuilds from saved assets), otherwise failed with an
  // explicit message. Attempts are not consumed by the restart itself.
  recoverOnBoot() {
    const requeued = [];
    const failed = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "processing") continue;
      const hasPayload = job.payloadStored || (job.payload !== undefined && job.payload !== null);
      const resumable = Boolean(job.projectId || hasPayload);
      if (resumable) {
        job.status = "queued";
        job.error = "Server restart — यहीं से resume होगा।";
        job.startedAt = null;
        job.updatedAt = nowIso();
        requeued.push(this.publicView(job));
      } else {
        job.status = "failed";
        job.error = "Server restart के दौरान काम पूरा नहीं हो सका। दोबारा शुरू करें।";
        job.finishedAt = nowIso();
        job.updatedAt = nowIso();
        failed.push(this.publicView(job));
      }
    }
    if (requeued.length || failed.length) this.save();
    return { requeued, failed };
  }

  prune() {
    if (this.jobs.size <= this.maxJobs) return 0;
    const finished = Array.from(this.jobs.values())
      .filter(job => TERMINAL.has(job.status))
      .sort((a, b) => String(a.finishedAt || a.updatedAt).localeCompare(String(b.finishedAt || b.updatedAt)));
    let removed = 0;
    for (const job of finished) {
      if (this.jobs.size <= this.maxJobs) break;
      this.remove(job.id);
      removed += 1;
    }
    // Last resort: the queue must stay bounded even when nothing has finished.
    if (this.jobs.size > this.maxJobs) {
      const waiting = Array.from(this.jobs.values())
        .filter(job => job.status === "queued")
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      for (const job of waiting) {
        if (this.jobs.size <= this.maxJobs) break;
        this.remove(job.id);
        removed += 1;
      }
    }
    return removed;
  }

  remove(id) {
    const job = this.jobs.get(String(id));
    if (!job) return false;
    this.jobs.delete(String(id));
    if (job.payloadStored) {
      try { fs.rmSync(this.payloadFile(job.id), { force: true }); } catch (_) {}
    }
    this.save();
    return true;
  }

  handler(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this._timer = setInterval(() => this.tick(), 500);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() {
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return this;
  }

  async tick(force) {
    if ((!this.running && !force) || this.activeJobId) return null;
    const job = this.claimNext();
    if (!job) return null;
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw Object.assign(new Error("इस job type का worker नहीं है।"), { statusCode: 500 });
      const result = await handler(job);
      return this.complete(job.id, result === undefined ? null : result);
    } catch (error) {
      this.logger("job " + job.id + " failed: " + (error && error.message));
      const retryable = !error.statusCode || error.statusCode >= 500;
      return this.fail(job.id, error, { retry: retryable });
    }
  }

  // Test helper: drain until no queued job is left.
  async drain(limit = 20) {
    for (let i = 0; i < limit; i += 1) {
      if (!(await this.tick(true))) break;
    }
    return this.list();
  }
}

function createJobQueue(options) {
  return new JobQueue(options);
}

module.exports = { JobQueue, createJobQueue, TERMINAL };
