"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {STEP_NAMES,validateJobInput,canTransitionJob,retryDelayMs,parseRetryAfter}=require("../automation-store");

test("job input normalizes topic and supported defaults",()=>{
 const j=validateJobInput({topic:" गाँव की मस्ती ",duration:"5"});
 assert.equal(j.topic,"गाँव की मस्ती");assert.equal(j.duration,5);assert.equal(j.visualStyle,"3d-cartoon");assert.equal(j.language,"Hindi");
 assert.match(j.idempotencyKey,/^[0-9a-f-]{36}$/);
});
test("rejects invalid topic and duration",()=>{
 assert.throws(()=>validateJobInput({topic:" "}),/topic/);
 assert.throws(()=>validateJobInput({topic:"x".repeat(501)}),/topic/);
 assert.throws(()=>validateJobInput({topic:"test",duration:0}),/duration/);
 assert.throws(()=>validateJobInput({topic:"test",duration:31}),/duration/);
});
test("idempotency keys are accepted only in a restricted format",()=>{
 assert.equal(validateJobInput({topic:"x",idempotencyKey:"mobile-run-0001"}).idempotencyKey,"mobile-run-0001");
 assert.notEqual(validateJobInput({topic:"x",idempotencyKey:"bad key"}).idempotencyKey,"bad key");
});
test("job transitions prevent restarting terminal jobs",()=>{
 assert.equal(canTransitionJob("draft","queued"),true);assert.equal(canTransitionJob("running","paused"),true);
 assert.equal(canTransitionJob("paused","queued"),true);assert.equal(canTransitionJob("completed","queued"),false);
 assert.equal(canTransitionJob("cancelled","running"),false);
});
test("retry delay is exponential and capped",()=>{
 assert.equal(retryDelayMs(0),1000);assert.equal(retryDelayMs(2),4000);assert.equal(retryDelayMs(30),60000);
});
test("Retry-After parses seconds and HTTP dates without guessing malformed values",()=>{
 const now=1800000000000;
 assert.equal(parseRetryAfter("12",now),now+12000);
 assert.equal(parseRetryAfter(new Date(now+30000).toUTCString(),now),now+30000);
 assert.equal(parseRetryAfter("not a date",now),null);assert.equal(parseRetryAfter(null,now),null);
});
test("pipeline steps distinguish still-image render from thumbnail and upload",()=>{
 assert.deepEqual(STEP_NAMES,["topic","script","seo","scene_plan","images","voice","captions","render","thumbnail","preview","youtube_upload"]);
});
