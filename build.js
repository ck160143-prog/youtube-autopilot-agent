"use strict";
const fs=require("node:fs"),path=require("node:path");
const {createProjectZip}=require("./zip-archive");
async function build(){const root=__dirname,dist=path.join(root,"dist");await fs.promises.mkdir(dist,{recursive:true});await fs.promises.copyFile(path.join(root,"index.html"),path.join(dist,"index.html"));const r=await createProjectZip({rootDir:root,outputPath:path.join(dist,"baba-ai-youtube-agent.zip")});console.log("Build OK: dist/index.html + dist/baba-ai-youtube-agent.zip created ("+r.fileCount+" files, "+r.archiveBytes+" bytes)");}
build().catch(e=>{console.error("Build failed: project ZIP could not be generated:",e.message);process.exitCode=1;});