#!/usr/bin/env node
/** Prepare and run the playground from source, using the caller's hwp binary. */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const binary=process.env.HWP_EDITOR_BIN?.trim() || process.env.HWP_CLI?.trim() || "hwp";
const env={...process.env,HWP_EDITOR_BIN:binary};
const shell=process.platform==="win32";
const probe=spawnSync(binary,["--version"],{cwd:root,env,encoding:"utf8"});
if(probe.error || probe.status!==0){
  process.stderr.write("The playground cannot run hwp; install hwp-cli or set HWP_EDITOR_BIN to its executable, then run pnpm playground again.\n");
  process.exit(1);
}
const pnpm=process.platform==="win32"?"pnpm.cmd":"pnpm";
function run(args){
  const result=spawnSync(pnpm,args,{cwd:root,env,stdio:"inherit",shell});
  if(result.error){process.stderr.write("The playground could not start pnpm; install the packageManager version and retry.\n");process.exit(1);}
  if(result.status!==0)process.exit(result.status??1);
}
run(["install","--frozen-lockfile"]);
run(["--filter","./packages/*","-r","--workspace-concurrency=1","build"]);
run(["--filter","playground","seed"]);
const child=spawn(pnpm,["--filter","playground","dev","-p","3100"],{cwd:root,env,stdio:"inherit",shell});
let stopping=false;
child.on("error",()=>{process.stderr.write("The playground server could not start; check pnpm and port 3100, then retry.\n");process.exitCode=1;});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{stopping=true;child.kill(signal);});
child.on("exit",code=>{process.exitCode=stopping?0:code??1;});
