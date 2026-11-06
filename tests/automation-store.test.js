"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {STEP_NAMES,validateJobInput,validateChannelTimezone,localDateKey,canTransitionJob,retryDelayMs,parseRetryAfter}=require("../automation-store");

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

test("manual schedule accepts a future timestamp and rejects past timestamps",()=>{
 const future=new Date(Date.now()+3600000).toISOString();
 assert.equal(validateJobInput({topic:"scheduled video",scheduledAt:future}).scheduledAt.toISOString(),future);
 assert.throws(()=>validateJobInput({topic:"late video",scheduledAt:"2020-01-01T00:00:00Z"}),/scheduledAt/);
});

test("channel timezone is validated as an IANA timezone",()=>{
 assert.equal(validateChannelTimezone("Asia/Kolkata"),"Asia/Kolkata");
 assert.equal(validateJobInput({topic:"tz job",channelTimezone:"America/Los_Angeles"}).channelTimezone,"America/Los_Angeles");
 assert.throws(()=>validateChannelTimezone("Mars/Olympus"),/IANA timezone/);
 assert.throws(()=>validateChannelTimezone(""),/IANA timezone/);
});
test("local scheduling date follows the channel timezone rather than UTC",()=>{
 const instant=new Date("2026-11-06T01:00:00.000Z");
 assert.equal(localDateKey(instant,"Asia/Kolkata"),"2026-11-06");
 assert.equal(localDateKey(instant,"America/Los_Angeles"),"2026-11-05");
});
test("local date keys remain correct across daylight-saving transitions",()=>{
 const beforeSpring=new Date("2026-03-08T07:30:00.000Z");
 const afterSpring=new Date("2026-03-08T08:30:00.000Z");
 assert.equal(localDateKey(beforeSpring,"America/Los_Angeles"),"2026-03-07");
 assert.equal(localDateKey(afterSpring,"America/Los_Angeles"),"2026-03-08");
});
