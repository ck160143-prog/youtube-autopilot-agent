"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {execFile}=require("node:child_process");
const {promisify}=require("node:util");
const execFileAsync=promisify(execFile);
const {renderStillSegment,concatenateSegments}=require("../segmented-renderer");
const ffmpegPath=require("ffmpeg-static");

test("FFmpeg renders and joins captioned 1280x720 narration segments with verified duration",{
  timeout:120000,
  skip:!ffmpegPath?"ffmpeg-static binary unavailable":false
},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"baba-segmented-ffmpeg-test-"));
 try{
  const imagePath=path.join(dir,"scene.png"),audioPath=path.join(dir,"audio.pcm"),captionPath=path.join(dir,"captions.srt");
  await execFileAsync(ffmpegPath,["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=1280x720:d=1","-frames:v","1","-y",imagePath],{timeout:30000});
  await execFileAsync(ffmpegPath,["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:duration=1","-ar","24000","-ac","1","-f","s16le","-y",audioPath],{timeout:30000});
  await fs.writeFile(captionPath,"1\n00:00:00,000 --> 00:00:01,000\nनमस्ते दोस्तों\n","utf8");
  const segments=[];
  for(let i=1;i<=2;i++){
   const outputPath=path.join(dir,"segment-"+i+".mp4");
   const rendered=await renderStillSegment({ffmpegPath,imagePath,audioPath,audioMime:"audio/L16",captionsPath:captionPath,outputPath,width:1280,height:720,timeoutMs:60000});
   assert.ok(rendered.size>1024);
   segments.push(outputPath);
  }
  const outputPath=path.join(dir,"final.mp4");
  const final=await concatenateSegments({ffmpegPath,segmentPaths:segments,outputPath,expectedDurationSeconds:2,timeoutMs:60000});
  assert.equal(final.verified,true);
  assert.ok(final.durationSeconds>=2 && final.durationSeconds<=2.2);
  const probe=await execFileAsync(ffmpegPath,["-hide_banner","-i",outputPath,"-f","null","-"],{timeout:30000}).catch(e=>e);
  assert.match(String(probe.stderr||""),/1280x720/);
  assert.ok((await fs.stat(outputPath)).size>1024);
 }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
});
