"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
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
    for (const migration of ["002_manual_schedule.sql","003_growth_dashboard.sql","004_global_automation_control.sql"]) {
      await pool.query(fs.readFileSync(path.join(__dirname, "../migrations/" + migration), "utf8"));
    }
    const first = await store.createJob(owner, { topic: "Phase 3 database integration check", duration: 1, idempotencyKey: key });
    assert.equal(first.created, true);
    jobId = first.job.id;

    const duplicate = await store.createJob(owner, { topic: "Should not replace original job", duration: 1, idempotencyKey: key });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, jobId, "same owner/idempotency key must return the existing job");

    const scheduledOwner = owner + "-schedule";
    const scheduledAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      const scheduled = await store.createJob(scheduledOwner, {
        topic: "Scheduled integration " + i, duration: 5,
        scheduledAt, idempotencyKey: "scheduled-" + i + "-" + crypto.randomUUID()
      });
      assert.equal(scheduled.created, true);
      assert.equal(new Date(scheduled.job.scheduled_at).toISOString(), scheduledAt.toISOString());
    }
    await assert.rejects(
      () => store.createJob(scheduledOwner, {
        topic: "Fourth scheduled video", duration: 5,
        scheduledAt, idempotencyKey: "scheduled-fourth-" + crypto.randomUUID()
      }),
      error => error && error.code === "DAILY_VIDEO_LIMIT_REACHED",
      "PostgreSQL must enforce no more than three scheduled videos per channel/day"
    );
    await pool.query("DELETE FROM baba_automation_jobs WHERE owner_channel_id=$1", [scheduledOwner]);

    const killJob = await store.createJob(owner, { topic: "Permanent stop queue gate", duration: 1, idempotencyKey: "kill-" + crypto.randomUUID() });
    await store.transition(owner, killJob.job.id, "queued");
    const control = await pool.query("SELECT state,permanently_stopped FROM baba_automation_control WHERE id=1");
    assert.equal(control.rows[0].state, "running");
    assert.equal(control.rows[0].permanently_stopped, false);
    await pool.query("UPDATE baba_automation_control SET state='paused' WHERE id=1");
    const paused = await pool.query("SELECT state FROM baba_automation_control WHERE id=1");
    assert.equal(paused.rows[0].state, "paused");
    await pool.query("UPDATE baba_automation_control SET state='stopped',permanently_stopped=TRUE WHERE id=1");
    assert.equal(await store.claimNextJob(), null, "permanent stop must prevent workers from claiming queued jobs");
    const stopped = await pool.query("SELECT state,permanently_stopped FROM baba_automation_control WHERE id=1");
    assert.equal(stopped.rows[0].state, "stopped");
    assert.equal(stopped.rows[0].permanently_stopped, true);
    await pool.query("UPDATE baba_automation_control SET state='running' WHERE id=1");
    const remainsStopped = await pool.query("SELECT state,permanently_stopped FROM baba_automation_control WHERE id=1");
    assert.equal(remainsStopped.rows[0].state, "running", "direct database maintenance can change state; application API blocks restart");
    assert.equal(remainsStopped.rows[0].permanently_stopped, true);
    assert.equal(await store.claimNextJob(), null, "permanent-stop flag remains an effective worker kill switch");
    await pool.query("UPDATE baba_automation_control SET state='running',permanently_stopped=FALSE WHERE id=1");



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

    assert.equal(await store.markUploadSessionCreationStarted(owner, jobId), true);
    assert.equal(await store.markUploadSessionCreationStarted(owner, jobId), false, "session creation must be one-shot until explicitly reconciled");
    await store.transition(owner, jobId, "failed");
    await assert.rejects(
      () => store.resetExpiredUploadSession(owner, jobId, false),
      error => error && error.code === "UPLOAD_RECONCILIATION_REQUIRED"
    );
    const reconciledUncertain = await store.resetExpiredUploadSession(owner, jobId, true);
    assert.equal(reconciledUncertain.upload_session_creation_started, false);
    assert.equal(reconciledUncertain.upload_session_url, null);

    assert.equal(await store.markUploadSessionCreationStarted(owner, jobId), true);
    await store.saveUploadSession(owner, jobId, "https://upload.example/session");
    const savedSession = await store.getJob(owner, jobId);
    assert.equal(savedSession.upload_session_url, "https://upload.example/session");
    assert.equal(savedSession.upload_session_creation_started, true);
    await store.transition(owner, jobId, "failed");
    const reconciledExpired = await store.resetExpiredUploadSession(owner, jobId, true);
    assert.equal(reconciledExpired.upload_session_url, null);
    assert.equal(reconciledExpired.upload_session_creation_started, false);
  } finally {
    if (jobId) await pool.query("DELETE FROM baba_automation_jobs WHERE id=$1", [jobId]).catch(() => {});
    await pool.query("DELETE FROM baba_automation_jobs WHERE owner_channel_id=$1", [owner]).catch(() => {});
    await store.close().catch(() => {});
  }
});
