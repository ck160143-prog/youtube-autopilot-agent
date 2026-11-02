"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { AutomationStore } = require("../automation-store");

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);

test("PostgreSQL schema, idempotency, job claiming, step checkpoint, pause/resume and restart recovery", {
  skip: !enabled ? "Set RUN_POSTGRES_INTEGRATION=1 and DATABASE_URL to run against an isolated PostgreSQL database" : false,
  timeout: 30000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 });
  const store = new AutomationStore({ pool });
  const owner = "phase3-integration-" + crypto.randomUUID();
  const key = "phase3-" + crypto.randomUUID();
  let jobId;
  try {
    await store.initialize();
    const first = await store.createJob(owner, { topic: "Phase 3 database integration check", duration: 1, idempotencyKey: key });
    assert.equal(first.created, true);
    jobId = first.job.id;

    const duplicate = await store.createJob(owner, { topic: "Should not replace original job", duration: 1, idempotencyKey: key });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, jobId, "same owner/idempotency key must return the existing job");

    await store.transition(owner, jobId, "queued");
    const claimed = await store.claimNextJob();
    assert.equal(claimed.id, jobId);
    assert.equal(claimed.status, "running");

    await store.startStep(owner, jobId, "topic");
    await store.finishStep(owner, jobId, "topic", {
      outputRef: "integration/topic.json",
      outputMetadata: { integration: true }
    });
    const topicState = await store.artifact(jobId, "topic");
    assert.equal(topicState.status, "succeeded");
    assert.equal(topicState.output_ref, "integration/topic.json");

    await assert.rejects(
      () => store.startStep(owner, jobId, "topic"),
      error => error && error.code === "STEP_NOT_RUNNABLE",
      "a succeeded step must not be generated again"
    );

    await store.startStep(owner, jobId, "script");
    const recoveredCount = await store.recoverInterruptedJobs();
    assert.equal(recoveredCount, 1, "a simulated worker restart should recover the running job");
    let recovered = await store.getJob(owner, jobId);
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.steps.find(s => s.step_name === "topic").status, "succeeded");
    assert.equal(recovered.steps.find(s => s.step_name === "script").status, "pending");
    assert.ok(recovered.events.some(e => e.event_type === "worker_recovery"));

    const reclaimed = await store.claimNextJob();
    assert.equal(reclaimed.id, jobId);
    await store.startStep(owner, jobId, "script");
    await store.finishStep(owner, jobId, "script", { outputRef: "integration/script.json" });

    await store.transition(owner, jobId, "paused");
    assert.equal((await store.getJob(owner, jobId)).status, "paused");
    await store.transition(owner, jobId, "queued");
    assert.equal((await store.getJob(owner, jobId)).status, "queued");
  } finally {
    if (jobId) await pool.query("DELETE FROM baba_automation_jobs WHERE id=$1", [jobId]).catch(() => {});
    await pool.query("DELETE FROM baba_automation_jobs WHERE owner_channel_id=$1", [owner]).catch(() => {});
    await store.close().catch(() => {});
  }
});
