"use strict";

// Storage abstraction.
//
// Why this exists: the app writes projects to a directory. On a host with an
// ephemeral filesystem (Render's free plan) every deploy deletes that directory,
// so users lose their videos. Rather than hard-wire one provider, everything
// goes through a tiny driver interface, and a second driver can be dropped in
// without touching the pipeline.
//
// Drivers:
//   local  - the directory it already uses (default, zero configuration)
//   s3     - any S3-compatible endpoint (Cloudflare R2, Backblaze B2, MinIO,
//            AWS S3). Configured with env vars; disabled unless all are set.
//
// The s3 driver is deliberately dependency-free: SigV4 is a few hashes of
// strings, and adding the AWS SDK (tens of MB) to a 512 MB instance for one PUT
// and one GET is a bad trade. It is tested against a fake fetch, so the signing
// and object layout are verified without any network call or account.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/;

function assertSafeKey(key) {
  const value = String(key || "");
  if (!SAFE_KEY.test(value) || value.includes("..")) {
    throw Object.assign(new Error("अमान्य storage key।"), { statusCode: 400 });
  }
  return value;
}

function localDriver(root) {
  const base = path.resolve(root);
  const resolve = key => {
    const full = path.resolve(base, assertSafeKey(key));
    // A key can never escape the root, even after normalisation.
    if (full !== base && !full.startsWith(base + path.sep)) {
      throw Object.assign(new Error("storage key root के बाहर है।"), { statusCode: 400 });
    }
    return full;
  };
  return {
    name: "local",
    async put(key, body) {
      const full = resolve(key);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, body);
      return { key, bytes: Buffer.byteLength(body) };
    },
    async get(key) {
      return fs.promises.readFile(resolve(key));
    },
    async has(key) {
      return fs.existsSync(resolve(key));
    },
    async remove(key) {
      await fs.promises.rm(resolve(key), { force: true });
    },
    locate(key) {
      return resolve(key);
    },
  };
}

// ---- S3-compatible driver (SigV4, path-style, no SDK) ----------------------

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// Returns an Authorization header for one request. Exported so the test can
// assert the exact canonical request instead of trusting it.
function signV4({ method, url, headers, payloadHash, accessKey, secretKey, region, datetime }) {
  const parsed = new URL(url);
  const stamp = datetime || new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  // Look the value up once per header; the previous version searched the key
  // list for every header and lost the value when the caller passed an empty or
  // mixed-case object.
  const byLower = {};
  for (const [name, value] of Object.entries(headers || {})) byLower[name.toLowerCase()] = String(value).trim();
  const signedHeaders = Object.keys(byLower).sort();
  const canonicalHeaders = signedHeaders.map(name => name + ":" + byLower[name] + "\n").join("");
  const canonicalRequest = [
    method,
    parsed.pathname,
    parsed.searchParams.toString(),
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const scope = day + "/" + region + "/s3/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + secretKey, day), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + scope +
    ", SignedHeaders=" + signedHeaders.join(";") + ", Signature=" + signature;
}

function s3Driver(config) {
  const endpoint = String(config.endpoint || "").replace(/\/+$/, "");
  const bucket = String(config.bucket || "");
  const region = String(config.region || "auto");
  const prefix = String(config.prefix || "baba").replace(/^\/+|\/+$/g, "");
  const fetchImpl = config.fetch || fetch;
  const objectUrl = key => endpoint + "/" + bucket + "/" + (prefix ? prefix + "/" : "") + assertSafeKey(key);

  const request = async (method, key, body) => {
    const url = objectUrl(key);
    const payload = body == null ? Buffer.alloc(0) : Buffer.from(body);
    const headers = {
      Host: new URL(url).host,
      "x-amz-content-sha256": sha256Hex(payload),
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    };
    if (body != null) headers["Content-Length"] = String(payload.length);
    headers.Authorization = signV4({
      method, url, headers, payloadHash: headers["x-amz-content-sha256"],
      accessKey: config.accessKey, secretKey: config.secretKey, region,
      datetime: headers["x-amz-date"],
    });
    const response = await fetchImpl(url, {
      method, headers,
      body: method === "PUT" ? payload : undefined,
      signal: AbortSignal.timeout(Number(config.timeoutMs) || 30000),
    });
    return response;
  };

  return {
    name: "s3",
    async put(key, body) {
      const response = await request("PUT", key, body);
      if (!response.ok) {
        throw Object.assign(new Error("Storage PUT विफल (HTTP " + response.status + ")"), { statusCode: 502 });
      }
      return { key, bytes: Buffer.byteLength(body) };
    },
    async get(key) {
      const response = await request("GET", key);
      if (response.status === 404) {
        throw Object.assign(new Error("Storage में object नहीं मिला।"), { statusCode: 404 });
      }
      if (!response.ok) {
        throw Object.assign(new Error("Storage GET विफल (HTTP " + response.status + ")"), { statusCode: 502 });
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async has(key) {
      try {
        const response = await request("HEAD", key);
        return response.ok;
      } catch (_) {
        return false;
      }
    },
    async remove(key) {
      await request("DELETE", key);
    },
    locate() {
      // Remote objects have no local path; callers must use get().
      return null;
    },
  };
}

// Builds the driver from environment. Unconfigured s3 falls back to local
// instead of pretending to have a backup.
function storageFromEnv(env = process.env, options = {}) {
  const localRoot = options.localRoot || env.STORAGE_LOCAL_DIR || path.join(env.DATA_DIR || process.cwd(), "backup");
  const s3Ready = Boolean(env.STORAGE_S3_ENDPOINT && env.STORAGE_S3_BUCKET &&
    env.STORAGE_S3_ACCESS_KEY && env.STORAGE_S3_SECRET_KEY);
  if (s3Ready) {
    return s3Driver({
      endpoint: env.STORAGE_S3_ENDPOINT,
      bucket: env.STORAGE_S3_BUCKET,
      accessKey: env.STORAGE_S3_ACCESS_KEY,
      secretKey: env.STORAGE_S3_SECRET_KEY,
      region: env.STORAGE_S3_REGION,
      prefix: env.STORAGE_S3_PREFIX,
      timeoutMs: env.STORAGE_TIMEOUT_MS,
      fetch: options.fetch,
    });
  }
  return localDriver(localRoot);
}

// What gets backed up, per project. The MP4 is the only thing that cannot be
// regenerated for free, so it goes first; the JSON lets a lost project be
// recognised even if the video is gone.
function backupPlan(project, projectDir, options = {}) {
  // The store keeps the project JSON as a sibling of the project directory
  // (projects/<id>.json), so a restore has to put it back there, not inside the
  // directory where nothing would read it.
  const recordFile = options.recordFile || path.join(path.dirname(path.resolve(projectDir)), project.id + ".json");
  const items = [];
  if (fs.existsSync(recordFile)) {
    items.push({ key: project.id + "/record.json", type: "file", file: recordFile });
  } else {
    items.push({ key: project.id + "/project.json", type: "json" });
  }
  // Look the video up by name before trusting the stored path: after a resumed
  // render, or a record copied from another host, render.videoPath can point at
  // a file that no longer exists while the real clip sits in the project
  // directory. Missing the MP4 silently is the worst failure mode here.
  const videoPath = [path.join(projectDir, "final.mp4"), path.join(projectDir, "render", "final.mp4")]
    .find(file => fs.existsSync(file) && fs.statSync(file).size > 0)
    || (project.render && project.render.videoPath);
  if (videoPath && fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0) {
    items.push({ key: project.id + "/final.mp4", type: "file", file: videoPath });
  }
  const thumbnail = path.join(projectDir, "thumbnail.png");
  if (fs.existsSync(thumbnail)) items.push({ key: project.id + "/thumbnail.png", type: "file", file: thumbnail });
  const captions = path.join(projectDir, "captions.srt");
  if (fs.existsSync(captions)) items.push({ key: project.id + "/captions.srt", type: "file", file: captions });
  return items;
}

// The manifest is what makes a restore possible without a `list` API: one
// object per project that names every key, its size and its hash. A restore can
// therefore verify what it wrote instead of trusting the transport.
function manifestKey(projectId) {
  return assertSafeKey(String(projectId) + "/manifest.json");
}

async function backupProject(storage, project, projectDir, options = {}) {
  const written = [];
  for (const item of backupPlan(project, projectDir, options)) {
    const body = item.type === "json" ? Buffer.from(JSON.stringify(project, null, 2), "utf8") : await fs.promises.readFile(item.file);
    const result = await storage.put(item.key, body);
    written.push({ key: item.key, bytes: result.bytes, sha256: sha256Hex(body), type: item.type });
  }
  const manifest = {
    projectId: project.id,
    // The owner travels with the backup: a restore cannot consult the project
    // record, because that record may be exactly what was lost.
    ownerId: project.ownerId || null,
    title: (project.story && project.story.title) || project.topic || null,
    savedAt: new Date().toISOString(),
    driver: storage.name,
    files: written,
    bytes: written.reduce((sum, f) => sum + f.bytes, 0),
  };
  const payload = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  await storage.put(manifestKey(project.id), payload);
  return {
    driver: storage.name,
    files: written,
    bytes: manifest.bytes,
    manifest: { key: manifestKey(project.id), sha256: sha256Hex(payload) },
  };
}

// Files a restore may place back. Everything else in a manifest is ignored, so
// a tampered backup cannot scatter files across the disk.
// `record.json` is the sibling JSON the project store actually reads; the older
// `project.json` slot is still accepted so existing backups stay restorable.
const RESTORE_SLOTS = {
  "final.mp4": "file",
  "thumbnail.png": "file",
  "captions.srt": "file",
  "project.json": "record",
  "record.json": "record",
};

async function readManifest(storage, projectId) {
  const key = manifestKey(projectId);
  if (!(await storage.has(key))) {
    throw Object.assign(new Error("इस प्रोजेक्ट का backup manifest नहीं मिला।"), { statusCode: 404 });
  }
  const raw = await storage.get(key);
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (_) {
    throw Object.assign(new Error("Backup manifest पढ़ा नहीं जा सका (खराब JSON)।"), { statusCode: 422 });
  }
  if (!manifest || !Array.isArray(manifest.files)) {
    throw Object.assign(new Error("Backup manifest में files की सूची नहीं है।"), { statusCode: 422 });
  }
  return manifest;
}

// Restores one project into <dataDir>/projects/<id>. Every byte is verified
// against the manifest hash, and only known filenames are written.
async function restoreProject(storage, projectId, options = {}) {
  const id = assertSafeKey(String(projectId));
  const dataDir = options.dataDir;
  if (!dataDir) throw Object.assign(new Error("restore के लिए dataDir चाहिए।"), { statusCode: 500 });
  const manifest = await readManifest(storage, id);
  const target = path.resolve(dataDir, "projects", id);
  const restored = [];
  const skipped = [];

  for (const entry of manifest.files) {
    // Real projects keep the MP4 at <id>/render/final.mp4, so the slot is the
    // file name, not the whole tail of the key — matching the full tail
    // silently skipped every video.
    const tail = String(entry.key || "").slice(id.length + 1);
    const slot = tail.split("/").filter(Boolean).pop();
    const kind = RESTORE_SLOTS[slot];
    if (!kind) {
      skipped.push({ key: entry.key, reason: "unknown slot" });
      continue;
    }
    const destination = kind === "record"
      ? path.join(path.resolve(dataDir, "projects"), id + ".json")
      : path.join(target, slot);
    const body = await storage.get(entry.key);
    if (entry.sha256 && sha256Hex(body) !== entry.sha256) {
      throw Object.assign(
        new Error("Backup फ़ाइल का hash मेल नहीं खाता: " + entry.key),
        { statusCode: 422 }
      );
    }
    // Defence in depth: the slot name is from a fixed table, but a resolved
    // path is still checked before a single byte is written.
    const allowedRoot = kind === "record" ? path.resolve(dataDir, "projects") : target;
    if (!destination.startsWith(allowedRoot + path.sep)) {
      throw Object.assign(new Error("restore path target के बाहर है।"), { statusCode: 400 });
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, body);
    restored.push({ key: entry.key, file: destination, bytes: body.length });
  }

  // The project record is rewritten in place so a restored video points at its
  // new path. It always lives beside the project directory, which is the only
  // place the store reads from.
  let project = null;
  const projectFile = path.join(path.resolve(dataDir, "projects"), id + ".json");
  if (fs.existsSync(projectFile)) {
    try {
      project = JSON.parse(fs.readFileSync(projectFile, "utf8"));
    } catch (_) {
      project = null; // a corrupt manifest copy must not abort the file restore
    }
  }
  if (project) {
    // The restored video is found by the key that was backed up, not by the
    // path stored in the record: after a move that path no longer exists.
    const moved = path.join(target, "final.mp4");
    if (fs.existsSync(moved)) {
      project.render = Object.assign({}, project.render, {
        videoPath: moved,
        size: fs.statSync(moved).size,
      });
    } else if (project.render) {
      project.render = Object.assign({}, project.render, { videoPath: null, size: 0 });
    }
    // Without this the store would still hold the pre-restore paths.
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
  }
  return {
    projectId: id,
    driver: storage.name,
    savedAt: manifest.savedAt || null,
    restored,
    skipped,
    project,
    dir: target,
  };
}

module.exports = {
  localDriver,
  s3Driver,
  storageFromEnv,
  signV4,
  sha256Hex,
  assertSafeKey,
  backupPlan,
  backupProject,
  restoreProject,
  readManifest,
  manifestKey,
  RESTORE_SLOTS,
};
