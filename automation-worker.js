"use strict";
const {STEP_NAMES}=require("./automation-store");
class AutomationWorker {
  constructor({store,storage,handlers={},pollMs=2500,logger=console}={}) {
    this.store=store;this.storage=storage;this.handlers=handlers;this.pollMs=Math.max(500,Number(pollMs)||2500);this.logger=logger;
    this.running=false;this.timer=null;this.activeJob=null;
  }
  async start(){
    if(this.running||!this.store?.configured||!this.storage?.configured)return false;
    await this.store.initialize();
    await this.store.recoverInterruptedJobs();
    this.running=true;
    this.loop().catch(e=>this.logger.error("Automation worker loop stopped",e?.code||e?.message||"unknown"));
    return true;
  }
  async stop(){this.running=false;if(this.timer)clearTimeout(this.timer);this.timer=null;}
  async loop(){
    while(this.running){
      try{
        const job=await this.store.claimNextJob();
        if(job){this.activeJob=job.id;try{await this.runJob(job);}catch(e){this.logger.error("Automation job failed",e?.code||e?.message||"unknown");}finally{this.activeJob=null;}continue;}
      }catch(e){this.logger.error("Automation worker poll failed",e?.code||e?.message||"unknown");}
      await new Promise(resolve=>{this.timer=setTimeout(resolve,this.pollMs);});
    }
  }
  async runJob(job){
    for(const step of STEP_NAMES){
      const fresh=await this.store.getJob(job.owner_channel_id,job.id);
      if(!fresh)return;
      if(fresh.status==="paused"||fresh.pause_requested)return;
      if(["completed","cancelled"].includes(fresh.status))return;
      const state=fresh.steps.find(s=>s.step_name===step);
      if(!state||state.status==="succeeded"||state.status==="skipped")continue;
      if(state.status==="failed") {await this.store.transition(job.owner_channel_id,job.id,"failed").catch(()=>{});return;}
      const handler=this.handlers[step];
      if(typeof handler!=="function"){
        await this.store.markJobFailed(job.owner_channel_id,job.id,step,"Pipeline handler not configured: "+step);
        return;
      }
      const cooldown=await this.store.getCooldown("gemini",step);
      if(cooldown&&["script","seo","scene_plan","images","voice"].includes(step)){
        await this.store.deferStep(job.owner_channel_id,job.id,step,cooldown.retry_after,"Provider cooldown active");
        return;
      }
      try{
        await this.store.startStep(job.owner_channel_id,job.id,step);
        const output=await handler({job: fresh,step,storage:this.storage,store:this.store});
        const outputRef=output?.buffer?await this.storage.put("jobs/"+job.id+"/"+step+"/"+(output.filename||"output.bin"),output.buffer,{contentType:output.contentType||"application/octet-stream",upsert:true}):output?.outputRef||null;
        const metadata=output?.metadata||{};
        await this.store.finishStep(job.owner_channel_id,job.id,step,{outputRef:typeof outputRef==="string"?outputRef:outputRef?.key||null,outputMetadata:metadata});
      }catch(error){
        const retryAfter=error?.retryAfter?new Date(error.retryAfter):null;
        if(error?.quotaProvider==="gemini"&&retryAfter){
          await this.store.setCooldown("gemini",step,retryAfter,error.message||"Gemini quota limit");
        }
        await this.store.finishStep(job.owner_channel_id,job.id,step,{errorMessage:error?.message||"Step failed",retryAfter}).catch(()=>{});
        await this.store.transition(job.owner_channel_id,job.id,"failed").catch(()=>{});
        return;
      }
    }
    await this.store.transition(job.owner_channel_id,job.id,"completed").catch(()=>{});
  }
}
module.exports={AutomationWorker};
