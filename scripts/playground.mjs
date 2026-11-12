#!/usr/bin/env node
/** Prepare and run the playground from source, using the caller's hwp binary. */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
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
//
// A candidate counts only when `spawn` could run it: existsSync was also true
// for a directory or a non-executable file named hwp, so the message could
// name an entry that was never run (#105 item 4).
function runnable(candidate){
  try{
    if(!statSync(candidate).isFile()) return null;
    // X_OK says nothing on Windows, where the extension and the file type are
    // what decide; on POSIX it is the bit the kernel checks.
    if(process.platform!=="win32") accessSync(candidate,constants.X_OK);
    return candidate;
  }catch{ return null; }
}
// libuv's fallback when the child environment carries no PATH (src/unix/
// process.c reads the libc's own default, _PATH_DEFPATH). The headers on both
// platforms this repo runs on define it as the same two entries: the macOS
// SDK's paths.h:65 and glibc's sysdeps/unix/sysv/linux/paths.h:36.
const DEFAULT_PATH="/usr/bin:/bin";
// libuv's Windows extension rule (src/win/process.c search_path): the name has
// an extension when its first dot is followed by a character, so `hwp.` counts
// as extensionless and `.hwp` does not.
function winNameHasExtension(name){
  const dot=name.indexOf(".");
  return dot>=0 && dot<name.length-1;
}
// An appended extension is joined with a dot unless the name already ends with
// one, so `hwp.` is probed as hwp.com and never as hwp..com.
function withExtension(name,ext){
  if(ext==="") return name;
  return (name.endsWith(".") ? name : `${name}.`)+ext;
}
// The entries libuv walks, in its order (src/win/process.c search_path,
// src/unix/process.c uv__spawn_resolve_and_spawn). An empty entry is the
// spawn's working directory: kept on POSIX, and dropped on Windows because that
// directory is already the first entry of the search. An unset PATH is that
// directory alone on Windows and the libc default on POSIX.
function pathEntries(){
  const raw=process.env.PATH;
  if(process.platform==="win32") return raw===undefined ? [] : raw.split(delimiter).filter(dir=>dir!=="");
  return (raw ?? DEFAULT_PATH).split(delimiter);
}
function onPath(name){
  // libuv's own search, which is what spawn runs (#105 item 4, #113 items 1 and
  // 2): on POSIX the PATH entries in order, on Windows the spawn's working
  // directory before them, with a relative entry resolved against that working
  // directory rather than against this process's. Windows tries the literal
  // name only when it already carries an extension, and appends .com and .exe
  // whether or not it does, so `hwp` is looked for as hwp.com then hwp.exe,
  // `hwp.exe` as hwp.exe then hwp.exe.com, and `hwp.` as hwp.com. PATHEXT plays
  // no part in either platform's search, so neither is it part of this report.
  //
  // Approximate on two Windows points that are not mirrored here:
  // NeedCurrentDirectoryForExePathW (whether the working directory is searched
  // at all) and quote stripping around the configured name.
  const win32=process.platform==="win32";
  const exts=win32 ? (winNameHasExtension(name) ? ["","com","exe"] : ["com","exe"]) : [""];
  const dirs=pathEntries();
  const search=win32 ? [root,...dirs] : dirs;
  for(const dir of search){
    // resolve(root,"") is root, which is the spawn's working directory: the
    // thing an empty POSIX entry names.
    const base=resolve(root,dir);
    for(const ext of exts){
      const found=runnable(join(base,withExtension(name,ext)));
      if(found!==null) return found;
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
