"use strict";

// Persistent job queue unit tests: state survives a restart, large payloads go
// to their own file, boot recovery requeues interrupted work, and the worker
// runs jobs one at a time.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { JobQueue } = require("../lib/jobs");

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baba-jobs-"));
}

test("jobs persist across queue instances", () => {
  const dir = freshDir();
  const first = new JobQueue({ dir }).load();
  const job = first.create({ type: "render", ownerId: "u1", payload: { hello: "world" } });
  first.complete(job.id, { size: 42 });

  const second = new JobQueue({ dir }).load();
  const reloaded = second.get(job.id);
  assert.ok(reloaded, "job must survive a restart");
  assert.equal(reloaded.status, "completed");
  assert.equal(reloaded.result.size, 42);
  assert.deepEqual(second.readPayload(reloaded), { hello: "world" });
});

test("large payloads are written to their own file, not into jobs.json", () => {
  const dir = freshDir();
  const queue = new JobQueue({ dir }).load();
  const big = "x".repeat(400 * 1024);
  const job = queue.create({ type: "render", ownerId: "u1", payload: { blob: big } });
  const stored = queue.get(job.id);
  assert.equal(stored.payloadStored, true);
  const index = fs.readFileSync(path.join(dir, "jobs.json"), "utf8");
  assert.equal(index.includes(big), false, "the queue index must stay small");
  assert.ok(fs.existsSync(path.join(dir, "payload-" + job.id + ".json")));
  assert.equal(queue.readPayload(stored).blob.length, big.length);
});

test("status transitions are persisted and listed", () => {
  const dir = freshDir();
  const queue = new JobQueue({ dir }).load();
  const a = queue.create({ type: "render", ownerId: "u1" });
  const b = queue.create({ type: "render", ownerId: "u2" });
  queue.fail(a.id, new Error("boom"), { retry: false });
  queue.cancel(b.id);

  const reloaded = new JobQueue({ dir }).load();
  assert.equal(reloaded.get(a.id).status, "failed");
  assert.match(reloaded.get(a.id).error, /boom/);
  assert.equal(reloaded.get(b.id).status, "cancelled");
  assert.deepEqual(reloaded.list({ ownerId: "u1" }).map(job => job.id), [a.id]);
  assert.equal(reloaded.list({ type: "render" }).length, 2);
});

test("a retryable failure requeues the job until attempts run out", () => {
  const dir = freshDir();
  const queue = new JobQueue({ dir }).load();
  const job = queue.create({ type: "render", maxAttempts: 2 });
  queue.claimNext();
  queue.fail(job.id, new Error("temporary"), { retry: true });
  assert.equal(queue.get(job.id).status, "queued");
  queue.claimNext();
  queue.fail(job.id, new Error("temporary again"), { retry: true });
  assert.equal(queue.get(job.id).status, "failed", "no infinite retry loop");
});

test("boot recovery requeues resumable work and fails unrecoverable jobs", () => {
  const dir = freshDir();
  const queue = new JobQueue({ dir }).load();
  const resumable = queue.create({ type: "render", maxAttempts: 1, payload: { n: 1 } });
  const notResumable = queue.create({ type: "render", maxAttempts: 1 });
  queue.track({ id: resumable.id, type: "render" });
  queue.track({ id: notResumable.id, type: "render" });
  assert.equal(queue.get(resumable.id).status, "processing");

  const restarted = new JobQueue({ dir }).load();
  const recovery = restarted.recoverOnBoot();
  assert.deepEqual(recovery.requeued.map(job => job.id), [resumable.id]);
  assert.deepEqual(recovery.failed.map(job => job.id), [notResumable.id]);
  assert.equal(restarted.get(resumable.id).status, "queued");
  assert.match(restarted.get(notResumable.id).error, /restart/i);
});

test("the worker runs queued jobs one at a time and stores results", async () => {
  const dir = freshDir();
  const queue = new JobQueue({ dir }).load();
  const seen = [];
  queue.handler("render", async job => {
    seen.push(job.id);
    return { size: job.payload.n * 2 };
  });
  const first = queue.create({ type: "render", payload: { n: 1 } });
  const second = queue.create({ type: "render", payload: { n: 2 } });
  await queue.drain(5);
  assert.deepEqual(seen, [first.id, second.id], "jobs run in FIFO order, never in parallel");
  assert.equal(queue.get(first.id).result.size, 2);
  assert.equal(queue.get(second.id).result.size, 4);
  assert.equal(queue.list({ status: "completed" }).length, 2);
});

test("a job that throws is marked failed with the error message", async () => {
  const dir = freshDir();
  const queue = new JobQueue({ dir }).load();
  queue.handler("render", async () => { throw new Error("FFmpeg नहीं मिला"); });
  const job = queue.create({ type: "render" });
  await queue.drain(3);
  assert.equal(queue.get(job.id).status, "failed");
  assert.match(queue.get(job.id).error, /FFmpeg/);
});

test("the queue keeps at most maxJobs finished records", () => {
  const dir = freshDir();
  const queue = new JobQueue({ dir, maxJobs: 5 }).load();
  for (let i = 0; i < 12; i += 1) queue.create({ type: "render" });
  assert.ok(queue.list().length <= 5, "queue must stay bounded, got " + queue.list().length);
});
