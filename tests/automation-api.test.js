"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {app}=require("../server");

test("automation status reports missing database and does not claim a worker exists",async()=>{
 const server=app.listen(0,"127.0.0.1");
 try{
  await new Promise(resolve=>server.once("listening",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  const status=await fetch(base+"/api/automation/status");
  assert.equal(status.status,200);
  const body=await status.json();
  assert.equal(body.databaseConfigured,false);
  assert.equal(body.durableJobMetadata,false);
  assert.equal(body.workerConfigured,false);
  assert.equal(body.durableRenderConfigured,false);
  const health=await fetch(base+"/api/health");
  assert.equal(health.status,200);
  assert.equal((await health.json()).status,"ok");
  const unauth=await fetch(base+"/api/automation/jobs");
  assert.equal(unauth.status,401);
 }finally{
  await new Promise(resolve=>server.close(resolve));
 }
});
