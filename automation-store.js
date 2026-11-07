"use strict";
const crypto = require("node:crypto");

const STEP_NAMES = Object.freeze(["topic","script","seo","scene_plan","images","voice","captions","render","thumbnail","preview","youtube_upload"]);
const JOB_STATES = new Set(["draft","queued","running","paused","failed","completed","cancelled"]);
const TERMINAL = new Set(["completed","cancelled"]);

function validateChannelTimezone(value = "Asia/Kolkata") {
  const timezone = typeof value === "string" ? value.trim() : "";
  if (!timezone || timezone.length > 100) throw new TypeError("channelTimezone must be a valid IANA timezone");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0)); }
  catch { throw new TypeError("channelTimezone must be a valid IANA timezone"); }
  return timezone;
}
function localDateKey(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}
function validateJobInput(input = {}) {
  const autoTopic = input.autoTopic === true;
  const topic = typeof input.topic === "string" ? input.topic.trim() : "";
  if ((!topic && !autoTopic) || topic.length > 500) throw new TypeError("topic must contain 1–500 characters, or set autoTopic=true");
  const storedTopic = topic || "__AUTO_TOPIC_PENDING__";
  const duration = Number(input.duration ?? 3);
  if (!Number.isInteger(duration) || duration < 1 || duration > 30) throw new TypeError("duration must be an integer from 1 to 30");
  const idempotencyKey = typeof input.idempotencyKey === "string" && /^[a-zA-Z0-9:_-]{8,128}$/.test(input.idempotencyKey)
    ? input.idempotencyKey : crypto.randomUUID();
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() - 60000) throw new TypeError("scheduledAt must be a valid current or future timestamp");
  const channelTimezone = validateChannelTimezone(input.channelTimezone);
  return { topic: storedTopic, autoTopic, duration, scheduledAt, channelTimezone, language: input.language === "English" ? "English" : "Hindi",
    visualStyle: ["3d-cartoon","cinematic","realistic"].includes(input.visualStyle) ? input.visualStyle : "3d-cartoon", idempotencyKey };
}
function canTransitionJob(from, to) {
  const transitions = { draft:["queued","cancelled"], queued:["running","paused","cancelled","failed"],
    running:["paused","completed","failed","cancelled","queued"], paused:["queued","cancelled"],
    failed:["queued","cancelled"], completed:[], cancelled:[] };
  return Boolean(transitions[from]?.includes(to));
}
function retryDelayMs(attempt, baseMs=1000, maxMs=60000) {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, Math.min(30, Number(attempt)||0))));
}
function parseRetryAfter(value, now=Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const s=String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return now + Math.max(0,Number(s)*1000);
  const date=Date.parse(s);
  return Number.isFinite(date) ? Math.max(now,date) : null;
}
class AutomationStore {
  constructor({pool, connectionString=process.env.DATABASE_URL}={}) {
    this.pool=pool||null;
    if (!this.pool && connectionString) {
      const {Pool}=require("pg");
      this.pool=new Pool({connectionString,max:Number(process.env.AUTOMATION_DB_POOL_MAX)||3,
        idleTimeoutMillis:30000,connectionTimeoutMillis:10000,
        ssl:process.env.DATABASE_SSL==="disable"?false:{rejectUnauthorized:true}});
    }
  }
  get configured(){return Boolean(this.pool);}
  async initialize(){
    if(!this.pool)return false;
    await this.pool.query("CREATE TABLE IF NOT EXISTS baba_automation_jobs (id UUID PRIMARY KEY, owner_channel_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, topic TEXT NOT NULL, duration INTEGER NOT NULL CHECK(duration BETWEEN 1 AND 30), language TEXT NOT NULL, visual_style TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','queued','running','paused','failed','completed','cancelled')), current_step TEXT, pause_requested BOOLEAN NOT NULL DEFAULT FALSE, upload_video_id TEXT, upload_visibility TEXT NOT NULL DEFAULT 'private' CHECK(upload_visibility IN ('private','unlisted','public')), upload_confirmed BOOLEAN NOT NULL DEFAULT FALSE, upload_authorized BOOLEAN NOT NULL DEFAULT FALSE, oauth_session_ciphertext TEXT, upload_idempotency_key TEXT, upload_session_url TEXT, upload_session_creation_started BOOLEAN NOT NULL DEFAULT FALSE, upload_progress_bytes BIGINT NOT NULL DEFAULT 0, upload_total_bytes BIGINT NOT NULL DEFAULT 0, asset_prefix TEXT, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(owner_channel_id,idempotency_key))");
    await this.pool.query("ALTER TABLE baba_automation_jobs ADD COLUMN IF NOT EXISTS upload_authorized BOOLEAN NOT NULL DEFAULT FALSE");
    await this.pool.query("ALTER TABLE baba_automation_jobs ADD COLUMN IF NOT EXISTS oauth_session_ciphertext TEXT");
    await this.pool.query("ALTER TABLE baba_automation_jobs ADD COLUMN IF NOT EXISTS upload_idempotency_key TEXT");
    await this.pool.query("ALTER TABLE baba_automation_jobs ADD COLUMN IF NOT EXISTS upload_session_url TEXT");
    await this.pool.query("ALTER TABLE baba_automation_jobs ADD COLUMN IF NOT EXISTS upload_session_creation_started BOOLEAN NOT NULL DEFAULT FALSE");
    await this.pool.query("ALTER TABLE baba_automation_jobs ADD COLUMN IF NOT EXISTS upload_progress_bytes BIGINT NOT NULL DEFAULT 0");
    await this.pool.query("ALTER TABLE baba_automation_jobs ADD COLUMN IF NOT EXISTS upload_total_bytes BIGINT NOT NULL DEFAULT 0");
    await this.pool.query("ALTER TABLE baba_automation_jobs ADD COLUMN IF NOT EXISTS asset_prefix TEXT");
    await this.pool.query("CREATE INDEX IF NOT EXISTS baba_automation_jobs_owner_created ON baba_automation_jobs(owner_channel_id,created_at DESC)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS baba_automation_steps (job_id UUID NOT NULL REFERENCES baba_automation_jobs(id) ON DELETE CASCADE, step_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','skipped')), attempt_count INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, retry_after TIMESTAMPTZ, output_ref TEXT, output_metadata JSONB NOT NULL DEFAULT '{}'::jsonb, error_message TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(job_id,step_name))");
    await this.pool.query("CREATE TABLE IF NOT EXISTS baba_automation_events (id BIGSERIAL PRIMARY KEY, job_id UUID NOT NULL REFERENCES baba_automation_jobs(id) ON DELETE CASCADE, step_name TEXT, event_type TEXT NOT NULL, message TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await this.pool.query("CREATE INDEX IF NOT EXISTS baba_automation_events_job ON baba_automation_events(job_id,created_at)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS baba_provider_cooldowns (provider TEXT NOT NULL, quota_scope TEXT NOT NULL, retry_after TIMESTAMPTZ NOT NULL, reason TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(provider,quota_scope))");
    return true;
  }
  async event(client,id,type,message,step=null,details={}) {
    await client.query("INSERT INTO baba_automation_events(job_id,step_name,event_type,message,details) VALUES($1,$2,$3,$4,$5::jsonb)",
      [id,step,type,String(message).slice(0,1000),JSON.stringify(details||{})]);
  }
  async createJob(owner,input,oauthSessionCiphertext=null){
    if(!this.pool)throw new Error("DATABASE_URL is required for durable automation jobs");
    if(typeof owner!=="string"||!owner.trim()||owner.length>256)throw new TypeError("A verified YouTube channel is required");
    const v=validateJobInput(input), c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const existing=await c.query("SELECT * FROM baba_automation_jobs WHERE owner_channel_id=$1 AND idempotency_key=$2 FOR UPDATE",[owner,v.idempotencyKey]);
      if(existing.rows[0]){await c.query("COMMIT");return {job:existing.rows[0],created:false};}
      // Enforce the daily cap by the channel's IANA timezone, not UTC.
      // PostgreSQL AT TIME ZONE handles 23/25-hour DST days without guessed offsets.
      const scheduleDay=localDateKey(v.scheduledAt,v.channelTimezone);
      const lockScope=v.channelTimezone+":"+scheduleDay;
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[owner,lockScope]);
      const count=await c.query("SELECT count(*)::int AS total FROM baba_automation_jobs WHERE owner_channel_id=$1 AND (scheduled_at AT TIME ZONE $3)::date=$2::date AND status <> 'cancelled'",[owner,scheduleDay,v.channelTimezone]);
      if(Number(count.rows[0]?.total||0)>=3){const e=new Error("Daily video limit of 3 has been reached for the selected date");e.code="DAILY_VIDEO_LIMIT_REACHED";throw e;}
      const id=crypto.randomUUID();
      const ins=await c.query("INSERT INTO baba_automation_jobs(id,owner_channel_id,idempotency_key,topic,duration,language,visual_style,status,oauth_session_ciphertext,upload_idempotency_key,asset_prefix,scheduled_at,channel_timezone) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12) ON CONFLICT(owner_channel_id,idempotency_key) DO NOTHING RETURNING *",
        [id,owner,v.idempotencyKey,v.topic,v.duration,v.language,v.visualStyle,oauthSessionCiphertext,crypto.randomUUID(),"jobs/"+id,v.scheduledAt,v.channelTimezone]);
      let job=ins.rows[0];
      if(job){
        for(const step of STEP_NAMES)await c.query("INSERT INTO baba_automation_steps(job_id,step_name,status) VALUES($1,$2,'pending')",[job.id,step]);
        await this.event(c,job.id,"job_created","Automation job draft created");
      }else{
        const duplicate=await c.query("SELECT * FROM baba_automation_jobs WHERE owner_channel_id=$1 AND idempotency_key=$2",[owner,v.idempotencyKey]);
        job=duplicate.rows[0];
      }
      await c.query("COMMIT");return {job,created:Boolean(ins.rows[0])};
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async getJob(owner,id){
    const r=await this.pool.query("SELECT * FROM baba_automation_jobs WHERE owner_channel_id=$1 AND id=$2",[owner,id]);
    if(!r.rows[0])return null;
    const [steps,events]=await Promise.all([
      this.pool.query("SELECT * FROM baba_automation_steps WHERE job_id=$1 ORDER BY array_position($2::text[],step_name)",[id,STEP_NAMES]),
      this.pool.query("SELECT id,step_name,event_type,message,details,created_at FROM baba_automation_events WHERE job_id=$1 ORDER BY id DESC LIMIT 100",[id])]);
    return {...r.rows[0],steps:steps.rows,events:events.rows};
  }
  async listJobs(owner,limit=30){
    const n=Math.max(1,Math.min(100,Number(limit)||30));
    const r=await this.pool.query("SELECT id,topic,duration,language,visual_style,status,current_step,last_error,upload_video_id,upload_visibility,upload_confirmed,upload_progress_bytes,upload_total_bytes,scheduled_at,created_at,updated_at FROM baba_automation_jobs WHERE owner_channel_id=$1 ORDER BY created_at DESC LIMIT $2",[owner,n]);
    return r.rows;
  }
  async transition(owner,id,target){
    if(!JOB_STATES.has(target))throw new TypeError("Invalid job status");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const r=await c.query("SELECT * FROM baba_automation_jobs WHERE owner_channel_id=$1 AND id=$2 FOR UPDATE",[owner,id]);
      const job=r.rows[0];if(!job){await c.query("ROLLBACK");return null;}
      if(!canTransitionJob(job.status,target)){const e=new Error("Invalid job state transition: "+job.status+" -> "+target);e.code="INVALID_TRANSITION";throw e;}
      const u=await c.query("UPDATE baba_automation_jobs SET status=$3,pause_requested=$4,updated_at=NOW() WHERE id=$1 AND owner_channel_id=$2 RETURNING *",[id,owner,target,target==="paused"]);
      await this.event(c,id,"job_"+target,"Job state changed to "+target);
      await c.query("COMMIT");return u.rows[0];
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async startStep(owner,id,step){
    if(!STEP_NAMES.includes(step))throw new TypeError("Unknown automation step");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const jr=await c.query("SELECT * FROM baba_automation_jobs WHERE owner_channel_id=$1 AND id=$2 FOR UPDATE",[owner,id]);
      const job=jr.rows[0];if(!job){await c.query("ROLLBACK");return null;}
      if(job.status==="paused"||job.pause_requested||TERMINAL.has(job.status)){const e=new Error("Job is paused or terminal");e.code="JOB_NOT_RUNNABLE";throw e;}
      const sr=await c.query("UPDATE baba_automation_steps SET status='running',attempt_count=attempt_count+1,started_at=NOW(),finished_at=NULL,error_message=NULL,updated_at=NOW() WHERE job_id=$1 AND step_name=$2 AND status='pending' AND (retry_after IS NULL OR retry_after<=NOW()) RETURNING *",[id,step]);
      if(!sr.rows[0]){const e=new Error("Step is not pending or its cooldown has not expired");e.code="STEP_NOT_RUNNABLE";throw e;}
      await c.query("UPDATE baba_automation_jobs SET status='running',current_step=$2,updated_at=NOW() WHERE id=$1",[id,step]);
      await this.event(c,id,"step_started","Step attempt started",step,{attempt:sr.rows[0].attempt_count});
      await c.query("COMMIT");return sr.rows[0];
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async finishStep(owner,id,step,{outputRef=null,outputMetadata={},errorMessage=null,retryAfter=null}={}){
    if(!STEP_NAMES.includes(step))throw new TypeError("Unknown automation step");
    if(outputRef!==null&&(typeof outputRef!=="string"||outputRef.length>2048))throw new TypeError("Use an object-storage reference, not asset bytes");
    const meta=JSON.stringify(outputMetadata||{});if(Buffer.byteLength(meta)>64000)throw new TypeError("Metadata exceeds 64 KB; store large assets in object storage");
    const failed=Boolean(errorMessage),c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const jr=await c.query("SELECT id FROM baba_automation_jobs WHERE owner_channel_id=$1 AND id=$2 FOR UPDATE",[owner,id]);
      if(!jr.rows[0]){await c.query("ROLLBACK");return null;}
      const sr=await c.query("UPDATE baba_automation_steps SET status=$3,finished_at=NOW(),updated_at=NOW(),output_ref=COALESCE($4,output_ref),output_metadata=CASE WHEN $5::jsonb='{}'::jsonb THEN output_metadata ELSE $5::jsonb END,error_message=$6,retry_after=$7,retry_count=retry_count+CASE WHEN $3='failed' THEN 1 ELSE 0 END WHERE job_id=$1 AND step_name=$2 AND status='running' RETURNING *",
        [id,step,failed?"failed":"succeeded",outputRef,meta,failed?String(errorMessage).slice(0,1000):null,retryAfter]);
      if(!sr.rows[0]){const e=new Error("Step was not running; refusing to overwrite its result");e.code="STEP_NOT_RUNNING";throw e;}
      await c.query("UPDATE baba_automation_jobs SET last_error=$2,status=CASE WHEN $3 THEN 'failed' ELSE status END,updated_at=NOW() WHERE id=$1",[id,failed?String(errorMessage).slice(0,1000):null,failed]);
      await this.event(c,id,failed?"step_failed":"step_succeeded",failed?String(errorMessage).slice(0,1000):"Step succeeded",step,{outputRef,retryAfter});
      await c.query("COMMIT");return sr.rows[0];
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async retryFailedStep(owner,id,step){
    if(!STEP_NAMES.includes(step))throw new TypeError("Unknown automation step");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const jr=await c.query("SELECT * FROM baba_automation_jobs WHERE owner_channel_id=$1 AND id=$2 FOR UPDATE",[owner,id]);
      const job=jr.rows[0];if(!job){await c.query("ROLLBACK");return null;}
      if(TERMINAL.has(job.status)){const e=new Error("Completed/cancelled jobs cannot retry");e.code="JOB_TERMINAL";throw e;}
      const sr=await c.query("UPDATE baba_automation_steps SET status='pending',error_message=NULL,retry_after=NULL,finished_at=NULL,updated_at=NOW() WHERE job_id=$1 AND step_name=$2 AND status='failed' RETURNING *",[id,step]);
      if(!sr.rows[0]){const e=new Error("Only a failed step can be retried");e.code="STEP_NOT_FAILED";throw e;}
      await c.query("UPDATE baba_automation_jobs SET status='queued',last_error=NULL,pause_requested=FALSE,updated_at=NOW() WHERE id=$1",[id]);
      await this.event(c,id,"step_retry_requested","Manual retry requested",step,{retryCount:sr.rows[0].retry_count});
      await c.query("COMMIT");return sr.rows[0];
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async setCooldown(provider,scope,retryAfter,reason="Provider quota limited"){
    const date=new Date(retryAfter);if(!provider||!scope||!Number.isFinite(date.getTime()))throw new TypeError("Valid provider, scope and retryAfter required");
    await this.pool.query("INSERT INTO baba_provider_cooldowns(provider,quota_scope,retry_after,reason,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(provider,quota_scope) DO UPDATE SET retry_after=GREATEST(baba_provider_cooldowns.retry_after,EXCLUDED.retry_after),reason=EXCLUDED.reason,updated_at=NOW()",
      [String(provider).slice(0,80),String(scope).slice(0,256),date,String(reason).slice(0,500)]);
  }
  async getCooldown(provider,scope){
    const r=await this.pool.query("SELECT provider,quota_scope,retry_after,reason FROM baba_provider_cooldowns WHERE provider=$1 AND quota_scope=$2 AND retry_after>NOW()",[provider,scope]);
    return r.rows[0]||null;
  }
  async getGlobalControl(){
    const result=await this.pool.query("SELECT state,permanently_stopped FROM baba_automation_control WHERE id=1");
    return result.rows[0]||null;
  }
  async pauseForGlobalControl(owner,id){
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const result=await c.query("UPDATE baba_automation_jobs SET status='paused',pause_requested=TRUE,global_pause=TRUE,updated_at=NOW() WHERE owner_channel_id=$1 AND id=$2 AND status='running' RETURNING id",[owner,id]);
      if(result.rows[0])await this.event(c,id,"job_paused_global","Job paused by global automation control");
      await c.query("COMMIT");return Boolean(result.rows[0]);
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async resumeGlobalPausedJobs(){
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const result=await c.query("UPDATE baba_automation_jobs SET status='queued',pause_requested=FALSE,global_pause=FALSE,updated_at=NOW() WHERE status='paused' AND global_pause=TRUE RETURNING id");
      for(const row of result.rows)await this.event(c,row.id,"job_resumed_global","Job queued after global automation resumed");
      await c.query("COMMIT");return result.rows.length;
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async claimNextJob(){
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const r=await c.query("SELECT * FROM baba_automation_jobs WHERE status='queued' AND NOT pause_requested AND (scheduled_at IS NULL OR scheduled_at<=NOW()) AND EXISTS (SELECT 1 FROM baba_automation_control WHERE id=1 AND state='running' AND NOT permanently_stopped) ORDER BY COALESCE(scheduled_at,created_at) ASC LIMIT 1 FOR UPDATE SKIP LOCKED");
      const job=r.rows[0];
      if(!job){await c.query("COMMIT");return null;}
      const u=await c.query("UPDATE baba_automation_jobs SET status='running',updated_at=NOW() WHERE id=$1 RETURNING *",[job.id]);
      await this.event(c,job.id,"worker_claimed","Background worker claimed job");
      await c.query("COMMIT");return u.rows[0];
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async recoverInterruptedJobs(){
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const stale=await c.query("SELECT id FROM baba_automation_jobs WHERE status='running' FOR UPDATE SKIP LOCKED");
      for(const row of stale.rows){
        await c.query("UPDATE baba_automation_steps SET status='pending',error_message='Worker restarted during this step; safely retrying from persisted assets where available',updated_at=NOW() WHERE job_id=$1 AND status='running'",[row.id]);
        await c.query("UPDATE baba_automation_jobs SET status='queued',pause_requested=FALSE,updated_at=NOW() WHERE id=$1",[row.id]);
        await this.event(c,row.id,"worker_recovery","Interrupted job returned to queue after worker restart");
      }
      await c.query("COMMIT");return stale.rows.length;
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async markJobFailed(owner,id,step,message){
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const sr=await c.query("UPDATE baba_automation_steps SET status='failed',finished_at=NOW(),error_message=$3,retry_count=retry_count+1,updated_at=NOW() WHERE job_id=$1 AND step_name=$2 AND status='pending' RETURNING *",[id,step,String(message).slice(0,1000)]);
      await c.query("UPDATE baba_automation_jobs SET status='failed',last_error=$3,updated_at=NOW() WHERE id=$1 AND owner_channel_id=$2",[id,owner,String(message).slice(0,1000)]);
      await this.event(c,id,"step_failed",message,step);
      await c.query("COMMIT");return sr.rows[0]||null;
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async deferStep(owner,id,step,retryAfter,message){
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      await c.query("UPDATE baba_automation_steps SET status='failed',retry_after=$3,error_message=$4,finished_at=NOW(),retry_count=retry_count+1,updated_at=NOW() WHERE job_id=$1 AND step_name=$2 AND status IN ('pending','running')",[id,step,retryAfter,String(message).slice(0,1000)]);
      await c.query("UPDATE baba_automation_jobs SET status='failed',last_error=$3,updated_at=NOW() WHERE id=$1 AND owner_channel_id=$2",[id,owner,String(message).slice(0,1000)]);
      await this.event(c,id,"step_deferred","Step stopped because provider cooldown is active",step,{retryAfter});
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async artifact(jobId,step){
    const r=await this.pool.query("SELECT output_ref,output_metadata,status FROM baba_automation_steps WHERE job_id=$1 AND step_name=$2",[jobId,step]);
    return r.rows[0]||null;
  }
  async replaceSegments(jobId, type, segments) {
    if (!["script","voice","scene","render"].includes(type) || !Array.isArray(segments)) throw new TypeError("Invalid segment manifest");
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT id FROM baba_automation_jobs WHERE id=$1 FOR UPDATE",[jobId]);
      for (const item of segments) {
        const id=String(item.id||"").slice(0,120), sequence=Number(item.sequence);
        if (!id || !Number.isInteger(sequence) || sequence<1) throw new TypeError("Invalid segment identity");
        const meta=JSON.stringify(item.metadata||{});
        if (Buffer.byteLength(meta)>64000) throw new TypeError("Segment metadata exceeds 64 KB");
        await c.query("INSERT INTO baba_automation_segments(job_id,segment_id,segment_type,sequence_no,status,input_ref,output_ref,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(job_id,segment_type,segment_id) DO UPDATE SET sequence_no=EXCLUDED.sequence_no,input_ref=COALESCE(EXCLUDED.input_ref,baba_automation_segments.input_ref),metadata=CASE WHEN EXCLUDED.metadata='{}'::jsonb THEN baba_automation_segments.metadata ELSE EXCLUDED.metadata END,updated_at=NOW()",
          [jobId,id,type,sequence,item.status||"pending",item.inputRef||null,item.outputRef||null,meta]);
      }
      await c.query("COMMIT");
      return this.listSegments(jobId,type);
    } catch(e) { await c.query("ROLLBACK").catch(()=>{}); throw e; }
    finally { c.release(); }
  }
  async listSegments(jobId,type) {
    const r=await this.pool.query("SELECT segment_id,segment_type,sequence_no,status,input_ref,output_ref,metadata,attempt_count,retry_after,last_error FROM baba_automation_segments WHERE job_id=$1 AND segment_type=$2 ORDER BY sequence_no",[jobId,type]);
    return r.rows;
  }
  async startSegment(jobId,type,id) {
    const r=await this.pool.query("UPDATE baba_automation_segments SET status='running',attempt_count=attempt_count+1,started_at=NOW(),finished_at=NULL,last_error=NULL,updated_at=NOW() WHERE job_id=$1 AND segment_type=$2 AND segment_id=$3 AND status IN ('pending','failed') AND (retry_after IS NULL OR retry_after<=NOW()) RETURNING *",[jobId,type,id]);
    if(!r.rows[0]) { const e=new Error("Segment is not ready to run"); e.code="SEGMENT_NOT_RUNNABLE"; throw e; }
    return r.rows[0];
  }
  async finishSegment(jobId,type,id,{outputRef=null,metadata={},error=null,retryAfter=null}={}) {
    if(outputRef!==null&&(typeof outputRef!=="string"||outputRef.length>2048)) throw new TypeError("Segment output must be an object-storage reference");
    const failed=Boolean(error), meta=JSON.stringify(metadata||{});
    if(Buffer.byteLength(meta)>64000) throw new TypeError("Segment metadata exceeds 64 KB");
    const r=await this.pool.query("UPDATE baba_automation_segments SET status=$4,output_ref=COALESCE($5,output_ref),metadata=CASE WHEN $6::jsonb='{}'::jsonb THEN metadata ELSE $6::jsonb END,last_error=$7,retry_after=$8,finished_at=NOW(),updated_at=NOW() WHERE job_id=$1 AND segment_type=$2 AND segment_id=$3 AND status='running' RETURNING *",
      [jobId,type,id,failed?"failed":"succeeded",outputRef,meta,failed?String(error).slice(0,1000):null,retryAfter]);
    if(!r.rows[0]) { const e=new Error("Segment was not running; refusing checkpoint overwrite"); e.code="SEGMENT_NOT_RUNNING"; throw e; }
    await this.eventForJob(jobId,failed?"segment_failed":"segment_succeeded",failed?String(error):"Segment checkpoint saved",{type,id,outputRef});
    return r.rows[0];
  }

  async authorizePrivateUpload(owner,id){
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const found=await c.query("SELECT status,upload_confirmed FROM baba_automation_jobs WHERE owner_channel_id=$1 AND id=$2 FOR UPDATE",[owner,id]);
      if(!found.rows[0]||found.rows[0].upload_confirmed){await c.query("ROLLBACK");return null;}
      const preview=await c.query("SELECT status FROM baba_automation_steps WHERE job_id=$1 AND step_name='preview'",[id]);
      if(preview.rows[0]?.status!=="succeeded"){const e=new Error("Preview must succeed before authorizing upload");e.code="PREVIEW_REQUIRED";throw e;}
      if(found.rows[0].status==="failed"){
        await c.query("UPDATE baba_automation_steps SET status='pending',error_message=NULL,retry_after=NULL,finished_at=NULL,updated_at=NOW() WHERE job_id=$1 AND step_name='youtube_upload' AND status='failed'",[id]);
      }
      const r=await c.query("UPDATE baba_automation_jobs SET upload_authorized=TRUE,status=CASE WHEN status IN ('paused','failed') THEN 'queued' ELSE status END,pause_requested=FALSE,updated_at=NOW() WHERE owner_channel_id=$1 AND id=$2 AND upload_confirmed=FALSE RETURNING *",[owner,id]);
      if(!r.rows[0]){await c.query("ROLLBACK");return null;}
      await this.event(c,id,"private_upload_authorized","User explicitly authorized a private YouTube upload","youtube_upload",{visibility:"private"});
      await c.query("COMMIT");return r.rows[0];
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async eventForJob(id,type,message,details={}){
    await this.pool.query("INSERT INTO baba_automation_events(job_id,event_type,message,details) VALUES($1,$2,$3,$4::jsonb)",[id,type,String(message).slice(0,1000),JSON.stringify(details||{})]);
  }
  async setJobTopic(owner,id,topic){
    if(typeof topic!=="string"||!topic.trim()||topic.trim().length>500)throw new TypeError("Generated topic must contain 1–500 characters");
    const r=await this.pool.query("UPDATE baba_automation_jobs SET topic=$3,updated_at=NOW() WHERE owner_channel_id=$1 AND id=$2 AND topic='__AUTO_TOPIC_PENDING__' RETURNING *",[owner,id,topic.trim()]);
    return r.rows[0]||null;
  }
  async saveOAuthSession(owner,id,ciphertext){
    await this.pool.query("UPDATE baba_automation_jobs SET oauth_session_ciphertext=$3,updated_at=NOW() WHERE owner_channel_id=$1 AND id=$2",[owner,id,ciphertext]);
  }
  async markUploadSessionCreationStarted(owner,id){
    const r=await this.pool.query("UPDATE baba_automation_jobs SET upload_session_creation_started=TRUE,updated_at=NOW() WHERE owner_channel_id=$1 AND id=$2 AND upload_confirmed=FALSE AND upload_video_id IS NULL AND upload_session_url IS NULL AND upload_session_creation_started=FALSE RETURNING id",[owner,id]);
    return Boolean(r.rows[0]);
  }
  async saveUploadSession(owner,id,url){
    await this.pool.query("UPDATE baba_automation_jobs SET upload_session_url=$3,upload_session_creation_started=TRUE,updated_at=NOW() WHERE owner_channel_id=$1 AND id=$2 AND upload_video_id IS NULL",[owner,id,url]);
  }
  async resetExpiredUploadSession(owner,id,confirmed){
    if(confirmed!==true){const e=new Error("Explicit confirmation that YouTube Studio has no matching upload is required");e.code="UPLOAD_RECONCILIATION_REQUIRED";throw e;}
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const r=await c.query("SELECT * FROM baba_automation_jobs WHERE owner_channel_id=$1 AND id=$2 FOR UPDATE",[owner,id]);
      const job=r.rows[0];
      if(!job||job.upload_confirmed||(!job.upload_session_url&&!job.upload_session_creation_started)||job.status!=="failed"){await c.query("ROLLBACK");return null;}
      await c.query("UPDATE baba_automation_steps SET status='pending',error_message=NULL,retry_after=NULL,finished_at=NULL,updated_at=NOW() WHERE job_id=$1 AND step_name='youtube_upload' AND status='failed'",[id]);
      const updated=await c.query("UPDATE baba_automation_jobs SET upload_session_url=NULL,upload_session_creation_started=FALSE,upload_progress_bytes=0,upload_total_bytes=0,status='queued',pause_requested=FALSE,upload_authorized=TRUE,last_error=NULL,updated_at=NOW() WHERE id=$1 RETURNING *",[id]);
      await this.event(c,id,"upload_session_reset","User confirmed no matching video exists in YouTube Studio; expired session reset","youtube_upload",{confirmed:true});
      await c.query("COMMIT");return updated.rows[0];
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async updateUploadProgress(owner,id,bytes,total){
    const sent=Math.max(0,Number(bytes)||0),size=Math.max(0,Number(total)||0);
    await this.pool.query("UPDATE baba_automation_jobs SET upload_progress_bytes=$3,upload_total_bytes=$4,updated_at=NOW() WHERE owner_channel_id=$1 AND id=$2 AND upload_confirmed=FALSE",[owner,id,sent,size]);
  }
  async markUploadConfirmed(owner,id,videoId,visibility="private"){
    if(!videoId||typeof videoId!=="string")throw new TypeError("YouTube video ID is required");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const r=await c.query("UPDATE baba_automation_jobs SET upload_video_id=$3,upload_visibility=$4,upload_confirmed=TRUE,upload_session_url=NULL,updated_at=NOW() WHERE owner_channel_id=$1 AND id=$2 AND upload_confirmed=FALSE RETURNING *",[owner,id,videoId,visibility]);
      if(!r.rows[0]){const e=new Error("Upload already confirmed or job not found; refusing duplicate confirmation");e.code="UPLOAD_ALREADY_CONFIRMED";throw e;}
      await this.event(c,id,"youtube_upload_confirmed","YouTube API confirmed upload","youtube_upload",{videoId,visibility});
      await c.query("COMMIT");return r.rows[0];
    }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
  }
  async close(){if(this.pool?.end)await this.pool.end();}
}
module.exports={AutomationStore,STEP_NAMES,JOB_STATES,validateJobInput,validateChannelTimezone,localDateKey,canTransitionJob,retryDelayMs,parseRetryAfter};
