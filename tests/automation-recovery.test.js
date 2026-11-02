"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {AutomationStore}=require("../automation-store");

function mockPool(){
 const calls=[];
 const client={
  async query(sql,params){calls.push({sql:String(sql),params});if(String(sql).includes("SELECT id FROM baba_automation_jobs WHERE status='running'"))return {rows:[{id:"11111111-1111-4111-8111-111111111111"}]};if(String(sql).includes("SELECT * FROM baba_automation_jobs WHERE status='queued'"))return {rows:[{id:"22222222-2222-4222-8222-222222222222",owner_channel_id:"channel-1",status:"queued"}]};if(String(sql).includes("UPDATE baba_automation_jobs SET status='running'"))return {rows:[{id:"22222222-2222-4222-8222-222222222222",status:"running"}]};return {rows:[]};},
  release(){}
 };
 return {calls,pool:{connect:async()=>client,query:client.query.bind(client)}};
}
test("restart recovery requeues interrupted jobs and resets only in-flight steps",async()=>{
 const {pool,calls}=mockPool(),store=new AutomationStore({pool});
 const count=await store.recoverInterruptedJobs();
 assert.equal(count,1);
 assert.ok(calls.some(c=>c.sql.includes("SET status='pending'")&&c.sql.includes("status='running'")));
 assert.ok(calls.some(c=>c.sql.includes("SET status='queued'")));
 assert.ok(calls.some(c=>c.sql.includes("INSERT INTO baba_automation_events")&&c.params?.includes("worker_recovery")));
});
test("queue claiming uses row locks to avoid two workers claiming the same job",async()=>{
 const {pool,calls}=mockPool(),store=new AutomationStore({pool});
 const job=await store.claimNextJob();
 assert.equal(job.status,"running");
 const select=calls.find(c=>c.sql.includes("SELECT * FROM baba_automation_jobs WHERE status='queued'"));
 assert.match(select.sql,/SKIP LOCKED/);
 assert.match(select.sql,/LIMIT 1/);
});
