"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { SupabaseObjectStorage } = require("../object-storage");

const enabled = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_STORAGE_BUCKET);
const privateBucketTest = test("Supabase private bucket persists image/audio/MP4 bytes and issues working signed URLs", {
  skip: !enabled ? "Set Supabase URL, service-role key and private bucket in a protected test environment" : false,
  timeout: 90000
}, async () => {
  const storage = new SupabaseObjectStorage();
  const prefix = "phase3-integration/" + crypto.randomUUID();
  const assets = [
    { key: prefix + "/sample.png", type: "image/png", bytes: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]) },
    { key: prefix + "/sample.mp3", type: "audio/mpeg", bytes: Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0010phase3-test") },
    { key: prefix + "/sample.mp4", type: "video/mp4", bytes: Buffer.from("000000186674797069736f6d", "hex") }
  ];
  try {
    for (const asset of assets) {
      await storage.put(asset.key, asset.bytes, { contentType: asset.type });
      const downloaded = await storage.get(asset.key);
      assert.deepEqual(downloaded, asset.bytes, asset.key + " must round-trip after storage write");

      const anonymous = await fetch(storage.objectUrl(asset.key));
      assert.equal(anonymous.ok, false, "private bucket must not allow anonymous object reads");

      const signed = await storage.signedUrl(asset.key, 120);
      assert.ok(signed.url && signed.expiresIn === 120);
      const preview = await fetch(signed.url);
      assert.equal(preview.status, 200, "signed preview URL must authorize reads");
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), asset.bytes);
    }
  } finally {
    for (const asset of assets) await storage.remove(asset.key).catch(() => {});
  }
});
