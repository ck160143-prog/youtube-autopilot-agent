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
      const globalControl = await this.store.getGlobalControl?.();
      if(globalControl?.permanently_stopped){
        if(!["completed","cancelled"].includes(fresh.status)) await this.store.transition(job.owner_channel_id,job.id,"cancelled").catch(()=>{});
        await this.store.eventForJob?.(job.id,"job_cancelled_global","Job stopped by permanent global kill switch");
        return;
      }
      if(globalControl?.state==="paused"||globalControl?.state==="stopped"){
        if(fresh.status==="running") await this.store.pauseForGlobalControl?.(job.owner_channel_id,job.id);
        return;
      }
      if(fresh.status==="paused"||fresh.pause_requested)return;
      if(["completed","cancelled"].includes(fresh.status))return;
      if(step==="youtube_upload"&&!fresh.upload_authorized){await this.store.transition(job.owner_channel_id,job.id,"paused").catch(()=>{});await this.store.eventForJob?.(job.id,"waiting_upload_confirmation","Waiting for explicit private-upload confirmation");return;}
      const state=fresh.steps.find(s=>s.step_name===step);
      if(!state||state.status==="succeeded"||state.status==="skipped")continue;
      if(state.status==="failed") {await this.store.transition(job.owner_channel_id,job.id,"failed").catch(()=>{});return;}
      const handler=this.handlers[step];
      if(typeof handler!=="function"){
        await this.store.markJobFailed(job.owner_channel_id,job.id,step,"Pipeline handler not configured: "+step);
        return;
      }
      const cooldown=await this.store.getCooldown("gemini","all") || await this.store.getCooldown("gemini",step);
      if(cooldown&&["script","seo","scene_plan","images","voice"].includes(step)){
        await this.store.deferStep(job.owner_channel_id,job.id,step,cooldown.retry_after,"Provider cooldown active");
        return;
      }
      let output=null, outputRef=null;
      try{
        await this.store.startStep(job.owner_channel_id,job.id,step);
        output=await handler({job:fresh,step,storage:this.storage,store:this.store,assertRunnable:async()=>{const current=await this.store.getJob(job.owner_channel_id,job.id);if(!current||current.status==="cancelled"){const e=new Error("Job cancelled at segment boundary");e.code="JOB_CANCELLED";throw e;}const control=await this.store.getGlobalControl?.();if(current.status==="paused"||current.pause_requested||control?.state==="paused"||control?.state==="stopped"){const e=new Error("Job paused at segment boundary");e.code="JOB_PAUSED";throw e;}}});
        outputRef=output?.buffer?await this.storage.put("jobs/"+job.id+"/"+step+"/"+(output.filename||"output.bin"),output.buffer,{contentType:output.contentType||"application/octet-stream",upsert:true}):output?.outputRef||null;
        const metadata={...(output?.metadata||{}),...(output?.contentType?{contentType:output.contentType}:{})};
        if(metadata.partialFailure){
          await this.store.finishStep(job.owner_channel_id,job.id,step,{outputRef:typeof outputRef==="string"?outputRef:outputRef?.key||null,outputMetadata:metadata,errorMessage:metadata.partialFailure});
          await this.store.transition(job.owner_channel_id,job.id,"failed").catch(()=>{});
          return;
        }
        await this.store.finishStep(job.owner_channel_id,job.id,step,{outputRef:typeof outputRef==="string"?outputRef:outputRef?.key||null,outputMetadata:metadata});
      }catch(error){
        if(error?.code==="JOB_PAUSED"||error?.code==="JOB_CANCELLED"){
          await this.store.releaseStepForControl(job.owner_channel_id,job.id,step,error.code==="JOB_PAUSED"?"paused":"cancelled").catch(()=>{});
          return;
        }
        const retryAfter=error?.retryAfter?new Date(error.retryAfter):null;
        if(error?.quotaProvider==="gemini"&&retryAfter){
          await this.store.setCooldown("gemini",step,retryAfter,error.message||"Gemini quota limit");
        }
        await this.store.finishStep(job.owner_channel_id,job.id,step,{outputRef:typeof outputRef==="string"?outputRef:outputRef?.key||null,outputMetadata:output?.metadata||{},errorMessage:error?.message||"Step failed",retryAfter}).catch(()=>{});
        await this.store.transition(job.owner_channel_id,job.id,"failed").catch(()=>{});
        return;
      }
    }
    await this.store.transition(job.owner_channel_id,job.id,"completed").catch(()=>{});
  }
}
module.exports={AutomationWorker};
