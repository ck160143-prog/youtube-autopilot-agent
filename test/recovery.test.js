"use strict";

// Restart recovery: a project that was mid-flight is marked interrupted, and a
// render job accepted before the crash is resumed by the next process — with a
// real FFmpeg render, not a mocked one.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { ProjectStore, createProject } = require("../lib/projects");
const { JobQueue } = require("../lib/jobs");

const FFMPEG = process.env.FFMPEG_PATH || "";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a project that was rendering is marked interrupted at boot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baba-rec-"));
  const store = new ProjectStore({ root });
  const project = createProject({ topic: "crash test" });
  project.status = "rendering";
  project.progress = { percent: 40, stage: "rendering", message: "MP4 render हो रहा है…" };
  store.save(project);

  const recovered = new ProjectStore({ root }).recoverInterrupted();
  assert.equal(recovered, 1);
  const after = store.get(project.id);
  assert.equal(after.status, "interrupted");
  assert.match(after.progress.message, /restart/i);
  assert.equal(after.progress.percent, 40, "the completed part of the work is not thrown away");

  const again = new ProjectStore({ root }).recoverInterrupted();
  assert.equal(again, 0, "an already interrupted project is not touched twice");
});

test("an interrupted project can be resumed and the stage runs again", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baba-rec2-"));
  const store = new ProjectStore({ root });
  const project = createProject({ topic: "resume test" });
  project.status = "generating";
  store.save(project);
  new ProjectStore({ root }).recoverInterrupted();
  assert.equal(store.get(project.id).status, "interrupted");
  // Resuming is just another run of the same stage: the status leaves
  // "interrupted" as soon as the pipeline starts writing again.
  store.setStatus(store.get(project.id), "generating", "दृश्य और आवाज़ बन रहे हैं…");
  assert.equal(store.get(project.id).status, "generating");
});

test("a queued job survives the process that created it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-rec3-"));
  const queue = new JobQueue({ dir }).load();
  const job = queue.create({ type: "render", payload: { keep: true }, maxAttempts: 2 });
  queue.track({ id: job.id, type: "render" });

  const restarted = new JobQueue({ dir }).load();
  const recovery = restarted.recoverOnBoot();
  assert.equal(recovery.requeued.length, 1);
  assert.equal(restarted.get(job.id).status, "queued");
  assert.deepEqual(restarted.readPayload(restarted.get(job.id)), { keep: true });
});

test("a render job interrupted by a restart is resumed and produces a real MP4", { timeout: 60000 }, () => {
  if (!FFMPEG || !fs.existsSync(FFMPEG)) {
    return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-restart-"));
  const jobsDir = path.join(dataDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  // One second of 24 kHz mono PCM silence and a 1x1 PNG: the exact payload the
  // Phase 1 render API accepts.
  const payload = {
    scenes: [{ imageBase64: PNG_1X1, mimeType: "image/png" }],
    audioBase64: Buffer.alloc(48000).toString("base64"),
    audioMime: "audio/L16;rate=24000",
  };
  fs.writeFileSync(path.join(jobsDir, "jobs.json"), JSON.stringify({
    version: 1,
    jobs: [{
      id: "crashed-job", type: "render", ownerId: null, projectId: null, stage: null,
      status: "processing", attempts: 1, maxAttempts: 1, error: null, result: null,
      createdAt: new Date(Date.now() - 60000).toISOString(),
      updatedAt: new Date(Date.now() - 30000).toISOString(),
      startedAt: new Date(Date.now() - 30000).toISOString(), finishedAt: null,
      payloadStored: false, payload,
    }],
  }));

  const script = [
    "process.env.DATA_DIR = " + JSON.stringify(dataDir) + ";",
    "require(" + JSON.stringify(path.join(__dirname, "..", "server")) + ");",
    "setTimeout(function () {",
    "  var fs = require('node:fs');",
    "  var data = JSON.parse(fs.readFileSync(" + JSON.stringify(path.join(jobsDir, "jobs.json")) + ", 'utf8'));",
    "  console.log('JOBS:' + JSON.stringify(data.jobs.map(function (j) {",
    "    return { id: j.id, status: j.status, error: j.error, result: j.result };",
    "  })));",
    "}, 6000);",
  ].join("\n");

  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dataDir, FFMPEG_PATH: FFMPEG, PORT: "0" },
    encoding: "utf8",
    timeout: 45000,
  });
  assert.equal(child.status, 0, "child process failed: " + child.stderr);
  const line = String(child.stdout).split("\n").find(item => item.startsWith("JOBS:"));
  assert.ok(line, "child did not report job state: " + child.stdout);
  const jobs = JSON.parse(line.slice("JOBS:".length));
  const job = jobs.find(item => item.id === "crashed-job");
  assert.ok(job, "the crashed job must still exist after the restart");
  assert.equal(job.status, "completed", "the job must be resumed, not dropped (error: " + job.error + ")");
  assert.ok(job.result && job.result.size > 0, "a real file must be produced");
  assert.ok(fs.existsSync(job.result.outputPath), "the resumed render must exist on disk");
  assert.ok(fs.statSync(job.result.outputPath).size > 1000);
});
