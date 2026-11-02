"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {transferChunks}=require("../automation-pipeline");
test("YouTube chunk upload persists monotonic progress and requires final API result",async()=>{
 const video=Buffer.alloc(8*1024*1024+10,7),updates=[],ranges=[];
 let calls=0;
 const store={async updateUploadProgress(owner,id,sent,total){updates.push([sent,total]);}};
 const fetchImpl=async(url,opts)=>{ranges.push(opts.headers["Content-Range"]);calls++;if(calls===1)return {status:308,ok:false};return {status:200,ok:true,json:async()=>({id:"yt-video-123"})};};
 const result=await transferChunks(fetchImpl,"https://upload.example/session","token",video,0,store,"channel","job");
 assert.equal(result.id,"yt-video-123");
 assert.deepEqual(ranges,["bytes 0-8388607/8388618","bytes 8388608-8388617/8388618"]);
 assert.deepEqual(updates.map(x=>x[0]),[0,8388608,video.length]);
});
test("YouTube chunk upload does not claim success when final API response is missing",async()=>{
 const video=Buffer.from("video"),store={async updateUploadProgress(){}};
 await assert.rejects(transferChunks(async()=>({status:500,ok:false}),"https://upload.example/session","token",video,0,store,"channel","job"),/HTTP 500/);
});
