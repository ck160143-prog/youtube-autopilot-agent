"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {makeSrt,retryAt}=require("../automation-pipeline");
test("caption sidecar creates valid sequential SRT blocks",()=>{
 const s=makeSrt("नमस्ते दोस्तों। आज गाँव में मज़ेदार घटना हुई।",4);
 assert.match(s,/1\n00:00:00,000 --> /);
 assert.match(s,/नमस्ते दोस्तों/);
 assert.match(s,/2\n/);
});
test("quota fallback cooldown is finite and does not loop API calls",()=>{
 const date=retryAt(new Error("RESOURCE_EXHAUSTED"));
 assert.ok(date instanceof Date);
 assert.ok(date.getTime()>Date.now());
});
