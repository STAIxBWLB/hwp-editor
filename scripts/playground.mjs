#!/usr/bin/env node
/** Prepare and run the playground from source, using the caller's hwp binary. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const configuredBinary=process.env.HWP_EDITOR_BIN?.trim() || process.env.HWP_CLI?.trim() || "hwp";
// A relative path is the caller's: pnpm runs this from the repo root but sets
// INIT_CWD to where the user ran it (#58 item 12).
const callerDir=process.env.INIT_CWD?.trim() || process.cwd();
const bareName=!(isAbsolute(configuredBinary) || configuredBinary.includes("/") || configuredBinary.includes("\\"));
const binary=bareName ? configuredBinary : resolve(callerDir,configuredBinary);
// `spawn` searches PATH for a bare name, so a refusal that repeats the name
// back ("cannot run hwp at hwp") says nothing about where it looked (#58 item
// 31). Report the entry that search would pick, or say it was PATH-wide.
function onPath(name){
  const exts=process.platform==="win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for(const dir of (process.env.PATH ?? "").split(delimiter)){
    if(!dir) continue;
    for(const ext of exts){
      const entry=join(dir,name+ext);
      if(existsSync(entry)) return entry;
    }
  }
  return null;
}
const place=bareName ? (onPath(configuredBinary) ?? `${configuredBinary} on PATH`) : binary;
const env={...process.env,HWP_EDITOR_BIN:binary};
const shell=process.platform==="win32";
const probe=spawnSync(binary,["--version"],{cwd:root,env,encoding:"utf8"});
if(probe.error || probe.status!==0){
  const cause=probe.error
    ? `error ${probe.error.code ?? probe.error.message}`
    : probe.signal ? `signal ${probe.signal}` : `exit status ${probe.status}`;
  process.stderr.write(`The playground cannot run hwp at ${place} (${cause}); install hwp-cli or set HWP_EDITOR_BIN to its executable, then run pnpm playground again.\n`);
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
