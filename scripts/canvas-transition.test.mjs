import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access,chmod,mkdir,mkdtemp,readFile,rm,stat,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkLegacyHealth,LEGACY_SHA,HEALTH_URL } from "./check-legacy-canvas-health.mjs";
import { checkHealth } from "./check-gateway-health.mjs";

const source=fileURLToPath(new URL("..",import.meta.url));
const HEALTH_SHA="af2f6be3d2c6d2f00565a9711b6e2543ea14ec99",FINAL_SHA="66495c5a5dcef0d12ea9b0e96501af9830e2f2c7",PREVIOUS_SHA="2e5a985882756f5a67b654c9b9b63ecaf4d50152";
const image=sha=>"ghcr.io/dijia1/infinite-canvas:sha-"+sha;
const tables=["app_member_roles","app_rbac_state","canvas_projects","canvas_save_requests","image_generation_task_inputs","image_generation_tasks","media","media_upload_intents","operation_logs","portal_members","private_folders","public_folders","public_images","settings","video_generation_tasks","workflow_media_refs","workflow_output_attempts","workflow_output_executions","workflow_runs","workflow_step_executions","workflows"];
function command(cmd,args,opts={}){const r=spawnSync(cmd,args,{encoding:"utf8",...opts});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
async function fixture(t,fault=""){
 const root=await mkdtemp(join(tmpdir(),"canvas-transition-test-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,"repo"),app=join(root,"app"),state=join(root,"state"),bin=join(root,"bin"),media=join(root,"media");
 await Promise.all([app,state,bin,media].map(p=>mkdir(p,{recursive:true})));
 command("git",["clone","--shared","--no-checkout",source,repo]);
 const git=args=>command("git",["-C",repo,...args]);
 git(["config","extensions.worktreeConfig","true"]);
 for(const sha of [LEGACY_SHA,PREVIOUS_SHA,HEALTH_SHA,FINAL_SHA]){
  const release=join(app,"releases",sha);
  git(["worktree","add","--no-checkout","--detach",release,sha]);
  command("git",["-C",release,"sparse-checkout","set","--no-cone","/docker-compose.yml","/scripts/deploy-production.sh","/scripts/release-state.sh","/scripts/initialize-release-state.sh","/scripts/cleanup-release-images.sh"]);
  command("git",["-C",release,"checkout",sha]);
 }
 await writeFile(join(app,".env"),"# Synthetic fixture only; no production configuration.\n");
 const stateFile=join(state,"infinite-canvas-release.last-known-good"),backupDir=join(state,"backups");
 await mkdir(backupDir);
 const backup=join(backupDir,"fixture.dump"),receiptFile=join(backupDir,"receipt.json");
 const backupContent="LOCAL SYNTHETIC TEST ARTIFACT; contains no real database or credentials.";
 await writeFile(backup,backupContent,{mode:0o600});
 const receipt={version:1,application:"infinite-canvas",database:"internal_tools",schema:"infinite_canvas",postgres_major:16,baseline_sha:LEGACY_SHA,health_sha:HEALTH_SHA,lifecycle_sha:FINAL_SHA,restore_verified:true,structure_verified:true,migration_verified:true,external_access_blocked:true,verified_at:new Date().toISOString(),snapshot_id:"SYNTHETIC-LOCAL-MOCK",snapshot_row_counts:Object.fromEntries(tables.map(x=>[x,0])),backup_path:backup,backup_sha256:createHash("sha256").update(backupContent).digest("hex")};
 await writeFile(receiptFile,JSON.stringify(receipt),{mode:0o600});
 const initialState=`version=2\ncurrent_sha=${LEGACY_SHA}\ncurrent_image=${image(LEGACY_SHA)}\ncurrent_release=${app}/releases/${LEGACY_SHA}\nprevious_sha=${PREVIOUS_SHA}\nprevious_image=${image(PREVIOUS_SHA)}\nprevious_release=${app}/releases/${PREVIOUS_SHA}\n`;
 await writeFile(stateFile,initialState,{mode:0o600});
 const model=join(root,"model.json"),actions=join(root,"actions.jsonl");
 await writeFile(model,JSON.stringify({active:image(LEGACY_SHA),fault,signalled:false}));
 const mock=`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2),m=JSON.parse(fs.readFileSync(process.env.MOCK_MODEL));
const legacy=${JSON.stringify(image(LEGACY_SHA))},health=${JSON.stringify(image(HEALTH_SHA))},final=${JSON.stringify(image(FINAL_SHA))};
const out=s=>{process.stdout.write(String(s)+'\\n');process.exit(0)},fail=()=>process.exit(1),save=()=>fs.writeFileSync(process.env.MOCK_MODEL,JSON.stringify(m));
fs.appendFileSync(process.env.MOCK_ACTIONS,JSON.stringify({args,image:process.env.INFINITE_CANVAS_IMAGE})+'\\n');
if(args[0]==='compose'){
 const c=args[args.indexOf('-f')+2],ref=process.env.INFINITE_CANVAS_IMAGE;
 if(c==='ps')out('fixture-container');
 if(c==='config'){if(m.fault==='target-config'&&ref===health)fail();out('');}
 if(c==='up'){
  m.active=ref;save();
  if(ref===health&&m.fault==='target-up')fail();
  if(ref===legacy&&m.fault==='rollback-failure')fail();
  out('');
 }
 if(c==='run'){if(m.fault==='final-migration')fail();out('');}
 fail();
}
if(args[0]==='pull'){
 if(m.fault==='target-pull'&&args[1]===health)fail();
 if(m.fault==='state-drift'&&args[1]===health)fs.appendFileSync(process.env.MOCK_STATE,'foreign_change=preserve\\n');
 out('');
}
if(args[0]==='image'&&args[1]==='inspect'){
 const ref=args.at(-1),fmt=args[args.indexOf('--format')+1];
 if(fmt.includes('Labels'))out(m.fault==='revision'&&ref===health?'f'.repeat(40):ref.split(':sha-')[1]);
 out('id-'+ref.split(':sha-')[1]);
}
if(args[0]==='inspect'){
 const fmt=args[args.indexOf('--format')+1];
 if(fmt==='{{.Image}}')out(m.fault==='container-image'&&m.active===legacy?'wrong-id':'id-'+m.active.split(':sha-')[1]);
 if(fmt==='{{.Config.Image}}')out(m.active);
 if(fmt.includes('State.Status')){
  const bad=(m.fault==='baseline-unhealthy'&&m.active===legacy)||(m.fault==='target-unhealthy'&&m.active===health);
  out('running '+(bad?'unhealthy':'healthy')+(fmt.includes('OOMKilled')?' false':''));
 }
 fail();
}
if(args[0]==='exec'){
 const code=fs.readFileSync(0,'utf8');
 if(m.fault==='signal'&&m.active===health&&!m.signalled){m.signalled=true;save();process.kill(process.ppid,'SIGTERM');fail();}
 const isLegacy=m.active===legacy;
 let status=200,type=isLegacy?'text/plain; charset=utf-8':'application/json',body=isLegacy?'ok':'{"ok":true}';
 if(m.fault==='baseline-spa'&&isLegacy){type='text/html';body='<html>ok</html>';}
 if(m.fault==='baseline-text'&&isLegacy)body='unavailable';
 if(m.fault==='target-gateway'&&m.active===health||m.fault==='rollback-failure'&&m.active===health||m.fault==='health-text-after-transition'&&m.active===health){type='text/plain';body='ok';}
 const prefix='globalThis.fetch=async()=>new Response('+JSON.stringify(body)+',{status:'+status+',headers:{"content-type":'+JSON.stringify(type)+'}});\\n';
 const nodeArgs=args.slice(args.indexOf('node')+1);
 const r=cp.spawnSync(process.execPath,nodeArgs,{input:prefix+code,encoding:'utf8'});
 process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);
}
if(args[0]==='ps')out('fixture-container');
if(args[0]==='image'&&args[1]==='ls')out('');
if(args[0]==='image'&&args[1]==='rm')fail();
fail();
`;
 await writeFile(join(bin,"docker"),mock,{mode:0o755});
 await writeFile(join(bin,"flock"),"#!/bin/sh\n[ \"$MOCK_FAULT\" != lock ]\n",{mode:0o755});
 await writeFile(join(bin,"mv"),"#!/bin/sh\n[ \"$MOCK_FAULT\" != state-write ] || exit 1\nexec /bin/mv \"$@\"\n",{mode:0o755});
 const env={...process.env,PATH:bin+":"+process.env.PATH,INFINITE_CANVAS_APP_DIR:app,INFINITE_CANVAS_RELEASE_STATE_DIR:state,INFINITE_CANVAS_MEDIA_DIR:media,MOCK_MODEL:model,MOCK_ACTIONS:actions,MOCK_STATE:stateFile,MOCK_FAULT:fault,DEPLOY_HEALTH_ATTEMPTS:"1",DEPLOY_HEALTH_INTERVAL:"0"};
 const transition=(mode="--apply")=>spawnSync("bash",[join(source,"scripts/transition-canvas-health.sh"),mode,receiptFile],{env,encoding:"utf8",timeout:30_000});
 const ordinary=()=>spawnSync("bash",[join(source,"scripts/deploy-production.sh"),FINAL_SHA,image(FINAL_SHA),join(app,"releases",FINAL_SHA)],{env,encoding:"utf8",timeout:30_000});
 const calls=async()=>{try{return(await readFile(actions,"utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)}catch{return[]}};
 return {root,app,state,backup,receiptFile,receipt,initialState,stateFile,model,actions,env,transition,ordinary,calls,active:async()=>JSON.parse(await readFile(model,"utf8"))};
}

for(const [name,status,type,body] of [["SPA",200,"text/html","ok"],["unavailable",503,"text/plain","unavailable"],["unexpected text",200,"text/plain","ok\n"],["new JSON",200,"application/json",'{"ok":true}'],["oversize",200,"text/plain","o".repeat(257)]]){
 test("legacy checker rejects "+name,async()=>{await assert.rejects(checkLegacyHealth(HEALTH_URL,LEGACY_SHA,{fetch:async()=>new Response(body,{status,headers:{"content-type":type}})}))});
}
test("legacy checker accepts only its fixed real old contract",async()=>{
 const fetch=async()=>new Response("ok",{headers:{"content-type":"text/plain"}});
 await checkLegacyHealth(HEALTH_URL,LEGACY_SHA,{fetch});
 await assert.rejects(checkLegacyHealth(HEALTH_URL,HEALTH_SHA,{fetch}));
 await assert.rejects(checkLegacyHealth(HEALTH_URL+"?x=1",LEGACY_SHA,{fetch}));
 await assert.rejects(checkLegacyHealth("https://other.test/apps/infinite-canvas/api/healthz",LEGACY_SHA,{fetch}));
});
test("ordinary checker continues rejecting plain text",async()=>{
 await assert.rejects(checkHealth(HEALTH_URL,{fetch:async()=>new Response("ok",{headers:{"content-type":"text/plain"}})}));
});
test("default plan performs no Docker or environment access",async t=>{
 const f=await fixture(t);
 const result=spawnSync("bash",[join(source,"scripts/transition-canvas-health.sh")],{env:{...f.env,INFINITE_CANVAS_APP_DIR:join(f.root,"absent")},encoding:"utf8"});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Plan only/);assert.deepEqual(await f.calls(),[]);
 await assert.rejects(access(join(f.state,"infinite-canvas-release.lock")));
});
test("readiness check neither creates a lock nor publishes a JSON baseline",async t=>{
 const f=await fixture(t),r=f.transition("--check");assert.equal(r.status,0,r.stderr);
 assert.equal(await readFile(f.stateFile,"utf8"),f.initialState);
 await assert.rejects(access(join(f.state,"infinite-canvas-release.lock")));
 assert.ok(!(await f.calls()).some(x=>x.args[0]==="pull"||x.args.includes("up")||x.args.includes("run")));
});
test("successful transition verifies actual strict response before atomically recording new current",async t=>{
 const f=await fixture(t),r=f.transition();assert.equal(r.status,0,r.stderr);
 const state=await readFile(f.stateFile,"utf8");assert.ok(state.includes("current_sha="+HEALTH_SHA));assert.ok(state.includes("previous_sha="+LEGACY_SHA));
 assert.equal((await f.active()).active,image(HEALTH_SHA));
 const calls=await f.calls();assert.ok(!calls.some(x=>x.args.includes("run")||x.args.includes("rm")),"no independent migration CLI or image cleanup in prerequisite transition");
 assert.equal((await stat(f.stateFile)).mode&0o777,0o600);
});
for(const fault of ["target-up","target-unhealthy","target-gateway","rollback-failure","state-write","signal"]){
 test(fault+" leaves original state and attempts precise legacy recovery",async t=>{
  const f=await fixture(t,fault),r=f.transition();assert.notEqual(r.status,0);
  assert.equal(await readFile(f.stateFile,"utf8"),f.initialState);
  const calls=await f.calls();assert.ok(calls.some(x=>x.args.includes("up")&&x.image===image(LEGACY_SHA)));
  assert.equal((await f.active()).active,image(LEGACY_SHA));
  assert.ok(!calls.some(x=>x.args[0]==="image"&&x.args[1]==="rm"));
  if(fault==="rollback-failure")assert.match(r.stderr,/recovery FAILED/);else assert.match(r.stderr,/real old contract/);
 });
}
for(const fault of ["target-pull","target-config","revision","container-image","baseline-unhealthy","baseline-spa","baseline-text","lock"]){
 test(fault+" refuses early without restarting any service or changing state",async t=>{
  const f=await fixture(t,fault),r=f.transition();assert.notEqual(r.status,0);
  assert.equal(await readFile(f.stateFile,"utf8"),f.initialState);assert.equal((await f.active()).active,image(LEGACY_SHA));
  assert.ok(!(await f.calls()).some(x=>x.args.includes("up")||x.args.includes("run")));
 });
}
test("foreign state drift is preserved and prevents switching",async t=>{
 const f=await fixture(t,"state-drift"),r=f.transition();assert.notEqual(r.status,0);
 assert.equal(await readFile(f.stateFile,"utf8"),f.initialState+"foreign_change=preserve\n");
 assert.ok(!(await f.calls()).some(x=>x.args.includes("up")));
});
for(const scenario of ["missing","stale","bad-checksum","restore-false","wrong-schema","public-file","symlink","incomplete-counts"]){
 test("backup receipt "+scenario+" fails before Docker work",async t=>{
  const f=await fixture(t),r={...f.receipt};
  if(scenario==="missing")await rm(f.receiptFile);
  else if(scenario==="public-file")await chmod(f.backup,0o644);
  else if(scenario==="symlink"){const {symlink}=await import("node:fs/promises");await rm(f.backup);await symlink(f.receiptFile,f.backup);}
  else{
   if(scenario==="stale")r.verified_at="2020-01-01T00:00:00Z";
   if(scenario==="bad-checksum")r.backup_sha256="0".repeat(64);
   if(scenario==="restore-false")r.restore_verified=false;
   if(scenario==="wrong-schema")r.schema="portal";
   if(scenario==="incomplete-counts")r.snapshot_row_counts={};
   await writeFile(f.receiptFile,JSON.stringify(r));
  }
  assert.notEqual(f.transition().status,0);assert.deepEqual(await f.calls(),[]);assert.equal(await readFile(f.stateFile,"utf8"),f.initialState);
 });
}
test("missing or dirty Git source metadata is refused without relabelling old state",async t=>{
 const f=await fixture(t);await writeFile(join(f.app,"releases",HEALTH_SHA,"docker-compose.yml"),"dirty");
 assert.notEqual(f.transition().status,0);assert.equal(await readFile(f.stateFile,"utf8"),f.initialState);
 assert.ok(!(await f.calls()).some(x=>x.args.includes("up")));
});
test("second-stage ordinary deployment succeeds after real JSON prerequisite, records previous health version",async t=>{
 const f=await fixture(t);assert.equal(f.transition().status,0);
 const r=f.ordinary();assert.equal(r.status,0,r.stderr);
 const state=await readFile(f.stateFile,"utf8");assert.ok(state.includes("current_sha="+FINAL_SHA));assert.ok(state.includes("previous_sha="+HEALTH_SHA));
 const calls=(await f.calls()).filter(x=>x.image===image(FINAL_SHA));
 assert.ok(calls.findIndex(x=>x.args.includes("run"))<calls.findIndex(x=>x.args.includes("up")),"migration precedes second-stage up");
});
test("ordinary deployment never accepts legacy text as a strict baseline",async t=>{
 const f=await fixture(t),r=f.ordinary();assert.notEqual(r.status,0);
 assert.equal(await readFile(f.stateFile,"utf8"),f.initialState);assert.ok(!(await f.calls()).some(x=>x.args[0]==="pull"||x.args.includes("up")||x.args.includes("run")));
});
test("second-stage migration failure restores JSON prerequisite and preserves its state",async t=>{
 const f=await fixture(t);assert.equal(f.transition().status,0);
 const state=await readFile(f.stateFile,"utf8"),model=await f.active();model.fault="final-migration";await writeFile(f.model,JSON.stringify(model));
 const r=f.ordinary();assert.notEqual(r.status,0);assert.equal((await f.active()).active,image(HEALTH_SHA));assert.equal(await readFile(f.stateFile,"utf8"),state);
});


test("missing Git metadata is never manufactured by the transition",async t=>{
 const f=await fixture(t);await rm(join(f.app,"releases",HEALTH_SHA,".git"));
 assert.notEqual(f.transition().status,0);assert.equal(await readFile(f.stateFile,"utf8"),f.initialState);
 await assert.rejects(access(join(f.app,"releases",HEALTH_SHA,".git")));
 assert.ok(!(await f.calls()).some(x=>x.args[0]==="pull"||x.args.includes("up")));
});
test("successful transition cannot be replayed against a different current baseline",async t=>{
 const f=await fixture(t);assert.equal(f.transition().status,0);
 const state=await readFile(f.stateFile,"utf8"),count=(await f.calls()).length;
 assert.notEqual(f.transition().status,0);assert.equal(await readFile(f.stateFile,"utf8"),state);
 assert.ok(!(await f.calls()).slice(count).some(x=>x.args.includes("up")||x.args[0]==="pull"));
});
test("a backup artifact outside application scope is rejected",async t=>{
 const f=await fixture(t),outside=join(f.root,"outside.dump");
 await writeFile(outside,await readFile(f.backup),{mode:0o600});
 await writeFile(f.receiptFile,JSON.stringify({...f.receipt,backup_path:outside}));
 assert.notEqual(f.transition().status,0);assert.deepEqual(await f.calls(),[]);
});
