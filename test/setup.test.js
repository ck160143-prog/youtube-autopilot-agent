"use strict";

// Setup guide: honest configuration audit, no secrets in responses, and a real
// verification call when a key is present.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-setup-"));

const { app, setAIClientFactoryForTests, resetAIClientFactory } = require("../server");
const { registerAndLogin, authHeaders } = require("./helpers");
const { auditSetup, redactSecrets, keyLooksValid, setupGuideFor, cleanSecret, readSecret, keyShape } = require("../lib/setup");
const ffmpegTools = require("../lib/ffmpeg");

let server;
let base;
let session;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await registerAndLogin(base, "setup_user");
});

test.after(() => server.close());

async function call(url, options) {
  return fetch(base + url, { ...(options || {}), headers: authHeaders(session, (options && options.headers) || {}) });
}

test("audit reports every check without leaking values", () => {
  // Built at runtime: the source file must not contain a credential-shaped
  // literal, or secret scanners (and reviewers) have to triage it.
  const key = ["A", "Iza", "z".repeat(35)].join("");
  const audit = auditSetup({
    env: { GEMINI_API_KEY: key, APP_REGISTRATION_KEY: "team-secret" },
    ffmpeg: { available: true, version: "9.0.2" },
    fontFile: require("../lib/fonts").resolveFontFile(),
    youtubeReady: false,
    lipSync: { available: false, source: "none" },
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "baba-setupdata-")),
  });
  assert.equal(audit.ok, true);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(key), false);
  assert.equal(serialized.includes("team-secret"), false);
  assert.equal(audit.checks.find(c => c.id === "GEMINI_API_KEY").status, "ok");
  assert.equal(audit.checks.find(c => c.id === "YOUTUBE_OAUTH").status, "blocked");
  assert.deepEqual(audit.missing, []);
});

test("a missing key produces a step-by-step guide", () => {
  const audit = auditSetup({ env: {}, dataDir: process.env.DATA_DIR, ffmpeg: { available: true } });
  assert.equal(audit.ok, false);
  assert.ok(audit.missing.includes("GEMINI_API_KEY"));
  const guide = audit.setupGuide.find(item => item.id === "GEMINI_API_KEY");
  assert.ok(guide.steps.length >= 3);
  assert.match(guide.steps.join(" "), /GEMINI_API_KEY/);
  assert.ok(guide.docs.startsWith("https://"));
});

test("redactSecrets strips keys and tokens from any message", () => {
  const key = ["A", "Iza", "a".repeat(35)].join("");
  const out = redactSecrets(
    "request failed for key " + key + " with secret=abc123 and password: hunter2",
    { GEMINI_API_KEY: key }
  );
  assert.equal(out.includes(key), false);
  assert.equal(out.includes("abc123"), false);
  assert.equal(out.includes("hunter2"), false);
  assert.match(out, /\*\*\*/);
});

test("key format check accepts Google keys and rejects junk", () => {
  assert.equal(keyLooksValid("AIza" + "b".repeat(35)), true);
  assert.equal(keyLooksValid("not-a-key"), false);
  assert.equal(keyLooksValid(""), false);
});

test("GET /api/setup returns the audit for a signed-in user", async () => {
  const response = await call("/api/setup");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.checks) && body.checks.length >= 5);
  assert.equal(typeof body.ok, "boolean");
  assert.ok(Array.isArray(body.setupGuide));
  assert.equal(JSON.stringify(body).includes(process.env.GEMINI_API_KEY || "\u0000"), false);
});

test("the setup guide endpoint serves instructions for a known check", async () => {
  const response = await call("/api/setup/guide/gemini_api_key");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.title, /Gemini/);
  assert.ok(body.steps.length >= 3);
  const missing = await call("/api/setup/guide/nope");
  assert.equal(missing.status, 404);
});

test("GET /api/setup requires a session", async () => {
  const response = await fetch(base + "/api/setup");
  assert.equal(response.status, 401);
});

test("verify reports real checks and never claims success without a key", async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const response = await call("/api/setup/verify", { method: "POST" });
    const body = await response.json();
    assert.equal(response.status, 200);
    const byId = Object.fromEntries(body.results.map(item => [item.id, item]));
    assert.equal(byId.GEMINI_API_KEY.status, "blocked");
    // FFMPEG is "ok" only where a real binary exists; elsewhere it must be
    // "blocked", never a fake "ok" with a null version.
    const ffmpegOk = await ffmpegTools.ffmpegAvailable();
    assert.equal(byId.FFMPEG.status, ffmpegOk ? "ok" : "blocked");
    if (!ffmpegOk) assert.match(byId.FFMPEG.detail, /नहीं चला/);
    assert.equal(byId.DATA_DIR.status, "ok");
    assert.equal(body.ok, false);
    assert.ok(Array.isArray(body.setupGuide) && body.setupGuide.length >= 1);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test("verify calls the real Gemini API when a key is configured", async () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "AIza" + "c".repeat(35);
  let listCalls = 0;
  setAIClientFactoryForTests(() => ({
    models: {
      list: async () => { listCalls += 1; return { page: async () => [{ name: "models/gemini-test" }] }; },
    },
  }));
  try {
    const response = await call("/api/setup/verify", { method: "POST" });
    const body = await response.json();
    const byId = Object.fromEntries(body.results.map(item => [item.id, item]));
    assert.equal(byId.GEMINI_API_KEY.status, "ok");
    assert.match(byId.GEMINI_API_KEY.detail, /accepted/);
    assert.equal(listCalls, 1, "verify must make exactly one metadata call");
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
    resetAIClientFactory();
  }
});

test("verify reports a rejected key honestly", async () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "AIza" + "d".repeat(35);
  setAIClientFactoryForTests(() => ({
    models: { list: async () => { throw new Error("API key not valid. Please pass a valid API key."); } },
  }));
  try {
    const response = await call("/api/setup/verify", { method: "POST" });
    const body = await response.json();
    const check = body.results.find(item => item.id === "GEMINI_API_KEY");
    assert.equal(check.status, "blocked");
    assert.match(check.detail, /not valid/i);
    assert.equal(body.ok, false);
    // A rejected key is configured but unusable. It must never be reported as
    // "missing": that wording sent users hunting for a variable that was set.
    assert.equal((body.missing || []).includes("GEMINI_API_KEY"), false);
    assert.equal((body.failed || []).includes("GEMINI_API_KEY"), true);
    assert.equal(check.reason, "rejected");
    assert.equal(body.keyShape.present, true);
    assert.equal(body.keyShape.looksLikeAIStudio, true);
    // The response explains the key without ever carrying it.
    assert.equal(JSON.stringify(body).includes(process.env.GEMINI_API_KEY), false);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
    resetAIClientFactory();
  }
});

test("a key pasted with quotes still works instead of being rejected", async () => {
  const previous = process.env.GEMINI_API_KEY;
  const realKey = "AIza" + "q".repeat(35);
  process.env.GEMINI_API_KEY = '"' + realKey + '"';   // exactly what a dashboard paste does
  setAIClientFactoryForTests(() => ({ models: { list: async () => ({ page: async () => [] }) } }));
  try {
    const response = await call("/api/setup/verify", { method: "POST" });
    const body = await response.json();
    const check = body.results.find(item => item.id === "GEMINI_API_KEY");
    assert.equal(check.status, "ok");
    assert.equal(body.keyShape.hadQuotes, true);
    assert.equal(body.keyShape.looksLikeAIStudio, true);
    // The key itself must not appear in either list: it is present and accepted.
    // (Model IDs may still be blocked here; that is a separate check.)
    assert.equal((body.failed || []).includes("GEMINI_API_KEY"), false);
    assert.equal((body.missing || []).includes("GEMINI_API_KEY"), false);
    assert.equal(JSON.stringify(body).includes(realKey), false);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
    resetAIClientFactory();
  }
});

test("the Gemini key is only ever read through readSecret", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const raw = source.match(/process\.env\.GEMINI_API_KEY/g) || [];
  assert.equal(raw.length, 1,
    "only keyShape may read the raw value; every other read bypasses cleanSecret");
  assert.match(source, /keyShape\(process\.env\.GEMINI_API_KEY\)/);
  assert.match(source, /apiKey: readSecret\("GEMINI_API_KEY"\)/);
});

test("cleanSecret strips matching quotes and whitespace, nothing else", () => {
  assert.equal(cleanSecret('"AIza123"'), "AIza123");
  assert.equal(cleanSecret("  'AIza123'\n"), "AIza123");
  assert.equal(cleanSecret("\"AIza123\""), "AIza123");
  // An unmatched quote is a real value problem and must not be silently "fixed".
  assert.equal(cleanSecret('"AIza123'), '"AIza123');
  assert.equal(cleanSecret("AIza123"), "AIza123");
  assert.equal(cleanSecret(null), "");
  assert.equal(readSecret("DEFINITELY_NOT_SET"), "");
});

test("keyShape describes a key without ever containing it", () => {
  const key = "AIza" + "k".repeat(35);
  const shape = keyShape('"' + key + '"');
  assert.deepEqual(shape, { present: true, length: 39, hadQuotes: true, looksLikeAIStudio: true });
  assert.equal(JSON.stringify(shape).includes(key), false);
  assert.equal(keyShape("").present, false);
});

test("setupGuideFor returns null for an unknown check", () => {
  assert.equal(setupGuideFor("NOT_A_CHECK"), null);
});

function snapshotModelEnv() {
  return {
    key: process.env.GEMINI_API_KEY,
    script: process.env.GEMINI_SCRIPT_MODEL,
    image: process.env.GEMINI_IMAGE_MODEL,
    tts: process.env.GEMINI_TTS_MODEL,
    fallback: process.env.GEMINI_SCRIPT_FALLBACK_MODEL,
  };
}

function restoreModelEnv(previous) {
  for (const [name, value] of [
    ["GEMINI_API_KEY", previous.key],
    ["GEMINI_SCRIPT_MODEL", previous.script],
    ["GEMINI_IMAGE_MODEL", previous.image],
    ["GEMINI_TTS_MODEL", previous.tts],
    ["GEMINI_SCRIPT_FALLBACK_MODEL", previous.fallback],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("verify checks every configured model from a single models.list call", async () => {
  const previous = snapshotModelEnv();
  process.env.GEMINI_API_KEY = "AIza" + "m".repeat(35);
  process.env.GEMINI_SCRIPT_MODEL = "gemini-script-test";
  process.env.GEMINI_IMAGE_MODEL = "gemini-image-test";
  process.env.GEMINI_TTS_MODEL = "gemini-tts-test";
  delete process.env.GEMINI_SCRIPT_FALLBACK_MODEL; // default, deliberately not listed
  let listCalls = 0;
  setAIClientFactoryForTests(() => ({
    models: {
      list: async () => {
        listCalls += 1;
        return { page: async () => [
          { name: "models/gemini-script-test" },
          { name: "models/gemini-image-test" },
          { name: "models/gemini-tts-test" },
          { name: "models/some-unrelated-model" },
        ] };
      },
    },
  }));
  try {
    const response = await call("/api/setup/verify", { method: "POST" });
    const body = await response.json();
    assert.equal(listCalls, 1, "one metadata call must answer every model question");
    const byRole = Object.fromEntries(body.models.map(model => [model.role, model]));
    assert.equal(byRole.script.status, "ok");
    assert.equal(byRole.image.status, "ok");
    assert.equal(byRole.tts.status, "ok");
    assert.equal(byRole.scriptFallback.status, "warn", "optional fallback is a warning, not a failure");
    // The models are visible, so the verdict follows only the host's FFmpeg.
    assert.equal(body.ok, await ffmpegTools.ffmpegAvailable());
    assert.equal(body.missing.includes("GEMINI_SCRIPT_FALLBACK_MODEL"), false);
    const byId = Object.fromEntries(body.results.map(item => [item.id, item]));
    assert.equal(byId.GEMINI_SCRIPT_MODEL.status, "ok");
    assert.equal(byId.GEMINI_IMAGE_MODEL.status, "ok");
    assert.equal(byId.GEMINI_TTS_MODEL.status, "ok");
    assert.equal(JSON.stringify(body).includes("AIza" + "m".repeat(35)), false);
  } finally {
    restoreModelEnv(previous);
    resetAIClientFactory();
  }
});

test("verify never claims availability for a model the key cannot see", async () => {
  const previous = snapshotModelEnv();
  process.env.GEMINI_API_KEY = "AIza" + "n".repeat(35);
  process.env.GEMINI_SCRIPT_MODEL = "gemini-ghost-script";
  delete process.env.GEMINI_IMAGE_MODEL;   // falls back to the declared default
  delete process.env.GEMINI_TTS_MODEL;
  delete process.env.GEMINI_SCRIPT_FALLBACK_MODEL;
  setAIClientFactoryForTests(() => ({
    models: { list: async () => ({ page: async () => [{ name: "models/gemini-unrelated" }] }) },
  }));
  try {
    const body = await (await call("/api/setup/verify", { method: "POST" })).json();
    const byRole = Object.fromEntries(body.models.map(model => [model.role, model]));
    assert.equal(byRole.script.status, "blocked");
    assert.equal(byRole.image.status, "blocked");
    assert.equal(byRole.tts.status, "blocked");
    assert.equal(byRole.scriptFallback.status, "warn");
    assert.equal(body.ok, false, "an invisible required model must fail the verdict");
    assert.ok(body.failed.includes("GEMINI_SCRIPT_MODEL"));
    assert.ok(body.failed.includes("GEMINI_IMAGE_MODEL"));
    assert.ok(body.failed.includes("GEMINI_TTS_MODEL"));
    assert.equal((body.missing || []).length, 0);
    const byId = Object.fromEntries(body.results.map(item => [item.id, item]));
    assert.match(byId.GEMINI_SCRIPT_MODEL.detail, /नहीं मिला/);
  } finally {
    restoreModelEnv(previous);
    resetAIClientFactory();
  }
});

test("verify reads the real SDK Pager shape, not only {page()}", async () => {
  const previous = snapshotModelEnv();
  process.env.GEMINI_API_KEY = "AIza" + "p".repeat(35);
  delete process.env.GEMINI_SCRIPT_MODEL;
  delete process.env.GEMINI_IMAGE_MODEL;
  delete process.env.GEMINI_TTS_MODEL;
  delete process.env.GEMINI_SCRIPT_FALLBACK_MODEL;
  setAIClientFactoryForTests(() => ({
    models: {
      // What @google/genai really returns: an async iterable Pager.
      list: async () => (async function* pager() {
        yield { name: "models/gemini-3.8-flash" };
        yield { name: "models/gemini-3.1-flash-image" };
      })(),
    },
  }));
  try {
    const body = await (await call("/api/setup/verify", { method: "POST" })).json();
    const byRole = Object.fromEntries(body.models.map(model => [model.role, model]));
    assert.equal(byRole.script.status, "ok");
    assert.equal(byRole.image.status, "ok");
    assert.equal(byRole.tts.status, "blocked", "absent from the pager means not available");
  } finally {
    restoreModelEnv(previous);
    resetAIClientFactory();
  }
});

test("lib/models resolves configured IDs from env or the declared default", () => {
  const { MODEL_CHECKS, configuredModels } = require("../lib/models");
  assert.equal(MODEL_CHECKS.length, 4);
  const custom = configuredModels({
    GEMINI_SCRIPT_MODEL: "custom-script",
    GEMINI_IMAGE_MODEL: "  ",            // whitespace counts as unset
    GEMINI_TTS_MODEL: "",
    GEMINI_SCRIPT_FALLBACK_MODEL: "custom-fallback",
  });
  const byRole = Object.fromEntries(custom.map(model => [model.role, model]));
  assert.equal(byRole.script.id, "custom-script");
  assert.equal(byRole.image.id, "gemini-3.1-flash-image", "blank env falls back to the declared default");
  assert.equal(byRole.tts.id, "gemini-2.5-flash-preview-tts");
  assert.equal(byRole.scriptFallback.id, "custom-fallback");
  assert.equal(byRole.scriptFallback.required, false);
  assert.equal(byRole.image.required, true);
});

test("lib/models reads every models.list shape without inventing IDs", async () => {
  const { listModelIds } = require("../lib/models");
  assert.deepEqual([...await listModelIds([{ name: "models/gemini-a" }, { id: "gemini-b" }])], ["gemini-a", "gemini-b"]);
  assert.deepEqual([...await listModelIds({ page: async () => [{ name: "models/gemini-c" }] })], ["gemini-c"]);
  const pager = (async function* () { yield { name: "models/gemini-d" }; yield { name: "models/gemini-e" }; })();
  assert.deepEqual([...await listModelIds(pager)], ["gemini-d", "gemini-e"]);
  // A broken pager must not hang or throw: it simply reports nothing.
  assert.deepEqual([...await listModelIds(null)], []);
});

test("an unconfigured backup is reported as a warning, not as healthy", () => {
  const { auditSetup } = require("../lib/setup");
  const base = {
    GEMINI_API_KEY: "not-a-real-key",
  };
  const env = Object.assign({}, process.env, base);
  delete env.STORAGE_S3_ENDPOINT;
  delete env.STORAGE_S3_BUCKET;
  delete env.STORAGE_S3_ACCESS_KEY;
  delete env.STORAGE_S3_SECRET_KEY;
  delete env.STORAGE_LOCAL_DIR;

  const report = auditSetup({
    env,
    ffmpeg: { available: true, version: "9.0" },
    fontFile: "/tmp/none.ttf",
    youtubeReady: true,
    lipSync: { available: true, source: "wasm" },
    dataDir: require("os").tmpdir(),
  });
  const check = report.checks.find(item => item.id === "BACKUP_STORAGE");
  assert.ok(check, "backup storage must be audited");
  assert.equal(check.status, "warning");
  assert.match(check.detail, /redeploy loses/);
  assert.ok(report.warnings.includes("BACKUP_STORAGE"));
  assert.ok(!report.missing.includes("BACKUP_STORAGE"), "it must not block rendering");
});

test("a configured backup reads as ok, and names the driver without leaking it", () => {
  const { auditSetup } = require("../lib/setup");
  const env = Object.assign({}, process.env, {
    GEMINI_API_KEY: "not-a-real-key",
    STORAGE_S3_ENDPOINT: "https://example.invalid",
    STORAGE_S3_BUCKET: "media",
    STORAGE_S3_ACCESS_KEY: "SECRETACCESSKEY",
    STORAGE_S3_SECRET_KEY: "SECRETVALUE",
  });
  const report = auditSetup({
    env,
    ffmpeg: { available: true, version: "9.0" },
    fontFile: "/tmp/none.ttf",
    youtubeReady: true,
    lipSync: { available: true, source: "wasm" },
    dataDir: require("os").tmpdir(),
  });
  const check = report.checks.find(item => item.id === "BACKUP_STORAGE");
  assert.equal(check.status, "ok");
  assert.match(check.detail, /S3-compatible/);
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes("SECRETACCESSKEY"), "an access key must never be echoed");
  assert.ok(!serialised.includes("SECRETVALUE"), "a secret key must never be echoed");
});

test("the backup warning carries instructions the operator can act on", () => {
  const { auditSetup } = require("../lib/setup");
  const env = Object.assign({}, process.env, { GEMINI_API_KEY: "not-a-real-key" });
  delete env.STORAGE_S3_ENDPOINT; delete env.STORAGE_S3_BUCKET;
  delete env.STORAGE_S3_ACCESS_KEY; delete env.STORAGE_S3_SECRET_KEY;
  delete env.STORAGE_LOCAL_DIR;
  const report = auditSetup({
    env, ffmpeg: { available: true, version: "9.0" }, fontFile: "/tmp/none.ttf",
    youtubeReady: true, lipSync: { available: true, source: "wasm" }, dataDir: require("os").tmpdir(),
  });
  const guide = report.warningGuide.find(item => item.id === "BACKUP_STORAGE");
  assert.ok(guide, "a warning without steps is just noise");
  assert.ok(guide.steps.length >= 3);
  assert.match(guide.steps.join(" "), /STORAGE_S3_ENDPOINT/);
  assert.ok(/secret/i.test(guide.steps.join(" ")) || /Secret/.test(guide.steps.join(" ")),
    "the guide must warn about secret handling");
});

test("every non-blocking problem reaches warnings[], whichever spelling it uses", () => {
  const { auditSetup, isWarning, WARNING_STATUS } = require("../lib/setup");
  // Three separate checks are non-blocking: a malformed key, a missing font and
  // an unset registration key. Before the fix only the backup check appeared,
  // because warnings[] filtered the single literal "warning" and these said
  // "warn" — so the operator was told everything was fine.
  const report = auditSetup({
    env: Object.assign({}, process.env, { GEMINI_API_KEY: "short" }),
    ffmpeg: { available: true, version: "9.0" },
    fontFile: "/tmp/definitely-not-a-font.ttf",
    youtubeReady: true,
    lipSync: { available: true, source: "wasm" },
    dataDir: require("os").tmpdir(),
  });
  const warnIds = report.checks.filter(c => isWarning(c.status)).map(c => c.id);
  assert.ok(warnIds.includes("GEMINI_API_KEY"), "a malformed key must be reported");
  assert.ok(warnIds.includes("DEVANAGARI_FONT"), "a missing font must be reported");
  assert.ok(warnIds.includes("REGISTRATION_KEY"), "a closed registration must be reported");
  for (const id of warnIds) {
    assert.ok(report.warnings.includes(id), id + " is a warning but missing from warnings[]");
  }
  assert.equal(WARNING_STATUS, "warning", "one canonical spelling must be exported");
  assert.equal(isWarning("warn"), true, "the legacy spelling must still be understood");
  assert.equal(isWarning("ok"), false);
  assert.equal(isWarning("blocked"), false);
});

test("no warning is left without an explanation", () => {
  const { auditSetup, isWarning } = require("../lib/setup");
  const report = auditSetup({
    env: Object.assign({}, process.env, { GEMINI_API_KEY: "short" }),
    ffmpeg: { available: true, version: "9.0" },
    fontFile: "/tmp/definitely-not-a-font.ttf",
    youtubeReady: true,
    lipSync: { available: true, source: "wasm" },
    dataDir: require("os").tmpdir(),
  });
  const warnIds = report.checks.filter(c => isWarning(c.status)).map(c => c.id);
  const guided = report.warningGuide.map(g => g.id);
  for (const id of warnIds) {
    assert.ok(guided.includes(id), id + " is a warning with no guide");
    const guide = report.warningGuide.find(g => g.id === id);
    assert.ok(guide.steps.length >= 2, id + " guide has no actionable steps");
  }
});
