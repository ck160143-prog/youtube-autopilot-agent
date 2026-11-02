"use strict";
const crypto = require("node:crypto");
const path = require("node:path");

function safeKey(key) {
  const value=String(key||"").replace(/\\/g,"/");
  if(!value || value.length>700 || value.startsWith("/") || value.split("/").some(p=>!p||p==="."||p==="..") || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError("Invalid object key");
  }
  return value;
}
class SupabaseObjectStorage {
  constructor({url=process.env.SUPABASE_URL,serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY,bucket=process.env.SUPABASE_STORAGE_BUCKET||"baba-ai-assets",fetchImpl=globalThis.fetch}={}) {
    this.url=String(url||"").replace(/\/+$/,"");
    this.serviceKey=serviceKey||"";
    this.bucket=bucket;
    this.fetch=fetchImpl;
  }
  get configured(){return Boolean(this.url&&this.serviceKey&&this.bucket);}
  assertConfigured(){if(!this.configured)throw Object.assign(new Error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_STORAGE_BUCKET for persistent assets."),{code:"OBJECT_STORAGE_NOT_CONFIGURED"});}
  headers(extra={}) {return {apikey:this.serviceKey,Authorization:"Bearer "+this.serviceKey,...extra};}
  objectUrl(key){return this.url+"/storage/v1/object/"+encodeURIComponent(this.bucket)+"/"+safeKey(key).split("/").map(encodeURIComponent).join("/");}
  async put(key,body,{contentType="application/octet-stream",upsert=false}={}) {
    this.assertConfigured(); key=safeKey(key);
    const bytes=Buffer.isBuffer(body)?body:Buffer.from(body);
    if(!bytes.length)throw new TypeError("Cannot store an empty asset");
    const response=await this.fetch(this.objectUrl(key),{method:"POST",headers:this.headers({"Content-Type":contentType,"x-upsert":upsert?"true":"false"}),body:bytes,signal:AbortSignal.timeout(60000)});
    if(!response.ok){const e=new Error("Object storage upload failed (HTTP "+response.status+")");e.status=response.status;throw e;}
    return {key,size:bytes.length,contentType,sha256:crypto.createHash("sha256").update(bytes).digest("hex")};
  }
  async get(key) {
    this.assertConfigured();
    const response=await this.fetch(this.objectUrl(key),{headers:this.headers(),signal:AbortSignal.timeout(60000)});
    if(!response.ok){const e=new Error("Object storage download failed (HTTP "+response.status+")");e.status=response.status;throw e;}
    return Buffer.from(await response.arrayBuffer());
  }
  async remove(key) {
    this.assertConfigured();
    const response=await this.fetch(this.url+"/storage/v1/object/"+encodeURIComponent(this.bucket),{method:"DELETE",headers:this.headers({"Content-Type":"application/json"}),body:JSON.stringify({prefixes:[safeKey(key)]}),signal:AbortSignal.timeout(30000)});
    if(!response.ok){const e=new Error("Object storage delete failed (HTTP "+response.status+")");e.status=response.status;throw e;}
    return true;
  }
  async signedUrl(key,expiresIn=3600) {
    this.assertConfigured();
    const seconds=Math.max(60,Math.min(604800,Number(expiresIn)||3600));
    const response=await this.fetch(this.url+"/storage/v1/object/sign/"+encodeURIComponent(this.bucket)+"/"+safeKey(key).split("/").map(encodeURIComponent).join("/"),{method:"POST",headers:this.headers({"Content-Type":"application/json"}),body:JSON.stringify({expiresIn:seconds}),signal:AbortSignal.timeout(15000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.signedURL){const e=new Error("Object storage signed URL failed (HTTP "+response.status+")");e.status=response.status;throw e;}
    const uri=data.signedURL.startsWith("http")?data.signedURL:this.url+"/storage/v1"+data.signedURL;
    return {url:uri,expiresIn:seconds};
  }
}
module.exports={SupabaseObjectStorage,safeKey};
