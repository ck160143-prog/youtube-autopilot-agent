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
function backupPlan(project, projectDir) {
  const items = [{ key: project.id + "/project.json", type: "json" }];
  if (project.render && project.render.videoPath && fs.existsSync(project.render.videoPath)) {
    items.push({ key: project.id + "/final.mp4", type: "file", file: project.render.videoPath });
  }
  const thumbnail = path.join(projectDir, "thumbnail.png");
  if (fs.existsSync(thumbnail)) items.push({ key: project.id + "/thumbnail.png", type: "file", file: thumbnail });
  const captions = path.join(projectDir, "captions.srt");
  if (fs.existsSync(captions)) items.push({ key: project.id + "/captions.srt", type: "file", file: captions });
  return items;
}

async function backupProject(storage, project, projectDir) {
  const written = [];
  for (const item of backupPlan(project, projectDir)) {
    const body = item.type === "json" ? Buffer.from(JSON.stringify(project, null, 2), "utf8") : await fs.promises.readFile(item.file);
    const result = await storage.put(item.key, body);
    written.push({ key: item.key, bytes: result.bytes });
  }
  return { driver: storage.name, files: written, bytes: written.reduce((sum, f) => sum + f.bytes, 0) };
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
};
