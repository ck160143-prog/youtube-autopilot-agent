"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {SupabaseObjectStorage,safeKey}=require("../object-storage");

test("object storage requires all credentials and validates keys",()=>{
 assert.equal(new SupabaseObjectStorage({url:"",serviceKey:""}).configured,false);
 assert.equal(safeKey("jobs/job-1/render/video.mp4"),"jobs/job-1/render/video.mp4");
 for(const key of ["../secret","/absolute","jobs//bad","jobs/./bad"])assert.throws(()=>safeKey(key),/Invalid object key/);
});
test("object storage uploads bytes with content type and returns a digest",async()=>{
 let seen;
 const storage=new SupabaseObjectStorage({url:"https://example.supabase.co",serviceKey:"service-secret",bucket:"assets",fetchImpl:async(url,options)=>{seen={url,options};return {ok:true,status:200};}});
 const result=await storage.put("jobs/j1/video.mp4",Buffer.from("video"),{contentType:"video/mp4"});
 assert.equal(result.size,5);assert.match(result.sha256,/^[a-f0-9]{64}$/);assert.equal(seen.options.method,"POST");
 assert.equal(seen.options.headers["Content-Type"],"video/mp4");assert.equal(seen.options.headers.Authorization,"Bearer service-secret");
});
test("object storage surfaces provider errors and does not silently accept missing config",async()=>{
 const storage=new SupabaseObjectStorage({url:"https://example.supabase.co",serviceKey:"secret",fetchImpl:async()=>({ok:false,status:413})});
 await assert.rejects(storage.put("a.bin",Buffer.from("x")),/HTTP 413/);
 await assert.rejects(new SupabaseObjectStorage().put("a.bin",Buffer.from("x")),/SUPABASE_URL/);
});
