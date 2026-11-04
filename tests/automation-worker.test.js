"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {AutomationWorker}=require("../automation-worker");
const {STEP_NAMES}=require("../automation-store");

function fakeStore(){
 const job={id:"job-1",owner_channel_id:"channel-1",status:"running",pause_requested:false,upload_authorized:true,steps:STEP_NAMES.map(step_name=>({step_name,status:"pending",attempt_count:0}))};
 return {
  job,configured:true,events:[],outputs:{},control:{state:"running",permanently_stopped:false},
  async initialize(){return true;},async recoverInterruptedJobs(){return 0;},
  async getGlobalControl(){return this.control;},
  async pauseForGlobalControl(){this.job.status="paused";this.job.pause_requested=true;return true;},
  async claimNextJob(){return null;},
  async getJob(){return {...this.job,steps:this.job.steps.map(x=>({...x}))};},
  async getCooldown(){return null;},
  async startStep(owner,id,name){const s=this.job.steps.find(x=>x.step_name===name);assert.equal(s.status,"pending");s.status="running";s.attempt_count++;return s;},
  async finishStep(owner,id,name,opts){const s=this.job.steps.find(x=>x.step_name===name);s.status=opts.errorMessage?"failed":"succeeded";s.output_ref=opts.outputRef;return s;},
  async transition(owner,id,status){this.job.status=status;return this.job;},
  async eventForJob(id,type,msg){this.events.push({type,msg});},
  async markJobFailed(){this.job.status="failed";},
  async deferStep(){this.job.status="failed";}
 };
}
test("worker executes each persisted stage and marks job complete",async()=>{
 const store=fakeStore(),storage={configured:true,async put(key){return {key};}};
 const seen=[];
 const handlers=Object.fromEntries(STEP_NAMES.map(step=>[step,async()=>{seen.push(step);return {buffer:Buffer.from(step),filename:"out.txt",contentType:"text/plain"};}]));
 const worker=new AutomationWorker({store,storage,handlers,logger:{error(){}}});
 await worker.runJob(store.job);
 assert.deepEqual(seen,STEP_NAMES);
 assert.equal(store.job.status,"completed");
 assert.ok(store.job.steps.every(s=>s.status==="succeeded"));
});
test("worker stops before YouTube upload until explicit private authorization",async()=>{
 const store=fakeStore(),storage={configured:true,async put(key){return {key};}};
 store.job.upload_authorized=false;
 const seen=[];
 const handlers=Object.fromEntries(STEP_NAMES.map(step=>[step,async()=>{seen.push(step);return {buffer:Buffer.from(step)};}]));
 const worker=new AutomationWorker({store,storage,handlers,logger:{error(){}}});
 await worker.runJob(store.job);
 assert.equal(store.job.status,"paused");
 assert.equal(seen.includes("youtube_upload"),false);
 assert.equal(seen.includes("preview"),true);
});
test("worker preserves completed stage outputs and does not rerun them",async()=>{
 const store=fakeStore(),storage={configured:true,async put(key){return {key};}};
 store.job.steps.find(s=>s.step_name==="topic").status="succeeded";
 const seen=[];
 const handlers=Object.fromEntries(STEP_NAMES.map(step=>[step,async()=>{seen.push(step);return {buffer:Buffer.from(step)};}]));
 const worker=new AutomationWorker({store,storage,handlers,logger:{error(){}}});
 await worker.runJob(store.job);
 assert.equal(seen.includes("topic"),false);
 assert.equal(store.job.status,"completed");
});

test("global pause stops active jobs at the next persisted step boundary",async()=>{
 const store=fakeStore(),storage={configured:true,async put(key){return {key};}};
 store.control.state="paused";
 const seen=[];
 const handlers=Object.fromEntries(STEP_NAMES.map(step=>[step,async()=>{seen.push(step);return {buffer:Buffer.from(step)};}]));
 const worker=new AutomationWorker({store,storage,handlers,logger:{error(){}}});
 await worker.runJob(store.job);
 assert.equal(store.job.status,"paused");
 assert.deepEqual(seen,[]);
});
test("permanent global stop cancels an active job and prevents further stage execution",async()=>{
 const store=fakeStore(),storage={configured:true,async put(key){return {key};}};
 store.control.state="stopped";store.control.permanently_stopped=true;
 const seen=[];
 const handlers=Object.fromEntries(STEP_NAMES.map(step=>[step,async()=>{seen.push(step);return {buffer:Buffer.from(step)};}]));
 const worker=new AutomationWorker({store,storage,handlers,logger:{error(){}}});
 await worker.runJob(store.job);
 assert.equal(store.job.status,"cancelled");
 assert.deepEqual(seen,[]);
});
