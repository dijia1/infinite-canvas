// Runs only against an explicitly supplied image and disposable local fixtures.
// Never reads app .env, production credentials, or the business UI.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const image = process.env.TEST_IMAGE;
function docker(...args) {
    const r=spawnSync("docker",args,{encoding:"utf8",timeout:120_000});
    assert.equal(r.status,0,r.stderr || r.error?.message);
    return r.stdout.trim();
}
function logs(name){const r=spawnSync("docker",["logs",name],{encoding:"utf8"});return r.stdout+r.stderr;}
async function until(check, timeout=60_000) {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){if(await check())return;await delay(100);}
    throw new Error("fixture deadline exceeded");
}
const document={nodes:[],connections:[],backgroundMode:"lines",showImageInfo:false,viewport:{x:0,y:0,k:1}};
function headers(){
 const issued=String(Math.floor(Date.now()/1000));
 return {"content-type":"application/json","X-Portal-User-Id":"1","X-Portal-User-Uid":"fixture-user","X-Portal-Username":"fixture-user","X-Portal-Roles":"","X-Portal-Identity-Time":issued,"X-Portal-Identity-Signature":createHmac("sha256","fixture-only-secret").update(["portal.identity.v1","infinite-canvas","1","fixture-user","fixture-user","",issued].join("\n")).digest("base64url")};
}

test("actual Node24/non-root Go+Next image drains writes, detached work and releases database connections",{skip:!image,timeout:180_000},async t=>{
 const id="canvas-lifecycle-"+randomUUID().slice(0,8),network=id+"-network",pg=id+"-pg",media=id+"-media";
 const containers=[pg];
 t.after(()=>{
  for(const name of containers.reverse())spawnSync("docker",["rm","-f",name],{stdio:"ignore"});
  spawnSync("docker",["volume","rm",media],{stdio:"ignore"});
  spawnSync("docker",["network","rm",network],{stdio:"ignore"});
 });
 docker("network","create",network);docker("volume","create",media);
 docker("run","-d","--name",pg,"--network",network,"-e","POSTGRES_USER=fixture","-e","POSTGRES_PASSWORD=fixture","-e","POSTGRES_DB=canvas_test","postgres:17-alpine");
 // The initialization server accepts only Unix sockets; wait for the final
 // TCP listener used by the app before running the single migration.
 await until(()=>spawnSync("docker",["exec",pg,"pg_isready","-h","127.0.0.1","-U","fixture","-d","canvas_test"],{stdio:"ignore"}).status===0);
 const env=["DATABASE_DSN=postgres://fixture:fixture@"+pg+":5432/canvas_test?sslmode=disable&application_name=canvas_lifecycle_fixture","PORTAL_DIRECTORY_SECRET=fixture-only-secret","MEDIA_STORAGE=oss","OSS_REGION=cn-hangzhou","OSS_BUCKET=fixture","OSS_INTERNAL_ENDPOINT=http://127.0.0.1:9","OSS_PUBLIC_ENDPOINT=http://127.0.0.1:9","OSS_ACCESS_KEY_ID=fixture","OSS_ACCESS_KEY_SECRET=fixture","GIN_MODE=release"];
 const flags=env.flatMap(value=>["-e",value]);
 docker("run","--rm","--network",network,...flags,"--entrypoint","/app/migrate",image);
 const sql=query=>docker("exec",pg,"psql","-U","fixture","-d","canvas_test","-Atc",query);
 sql("INSERT INTO portal_members(user_uid,display_name,enabled,roles) VALUES ('fixture-user','fixture',true,'[]')");
 const start=async suffix=>{
  const app=id+suffix;containers.push(app);
  docker("run","-d","--init","--stop-timeout","30","--name",app,"--network",network,"-p","127.0.0.1::3000","-p","127.0.0.1::8082","--mount",`type=volume,src=${media},dst=/app/data/media,volume-nocopy`,...flags,image);
  const ports=JSON.parse(docker("inspect","--format","{{json .NetworkSettings.Ports}}",app));
  const front="http://127.0.0.1:"+ports["3000/tcp"][0].HostPort,api="http://127.0.0.1:"+ports["8082/tcp"][0].HostPort;
  await until(async()=>{try{return(await fetch(front+"/api/healthz",{signal:AbortSignal.timeout(2000)})).ok}catch{return false}});
  const meta=JSON.parse(docker("exec",app,"node","-e","console.log(JSON.stringify({node:process.versions.node,uid:process.getuid(),gid:process.getgid()}))"));
  assert.match(meta.node,/^24\./);assert.equal(meta.uid,1000);assert.equal(meta.gid,1000);
  assert.equal(docker("inspect","--format","{{.HostConfig.Init}} {{.Config.StopTimeout}}",app),"true 30");
  assert.equal(docker("exec",app,"stat","-c","%u:%g/%a","/app/data/media"),"0:0/755");
  docker("exec",app,"ffmpeg","-version");
  return {app,front,api};
 };
 const request=async(url,body,method="POST")=>{
  const r=await fetch(url,{method,headers:headers(),body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});
  assert.equal(r.status,200,url);return r.json();
 };
 let f=await start("-write");
 assert.equal((await fetch(f.front+"/api/session")).status,401,"unsigned identity must fail");
 const created=await request(f.front+"/api/v1/canvas/projects",{id:"fixture-board",title:"before",document});
 assert.equal(created.code,0);
 const intent=await request(f.front+"/api/v1/media/upload-intents",{filename:"fixture.png",contentType:"image/png",bytes:16,intent:"library"});
 assert.equal(intent.code,0,JSON.stringify(intent));
 assert.equal(intent.data.mode,"direct","OSS must remain active despite an unwritable root-owned media mount");
 assert.equal(docker("exec",f.app,"find","/app/data/media","-mindepth","1","-print"),"","OSS mode must not fall back to the local mount");
 const locked=async()=>{
  const p=spawn("docker",["exec","-i",pg,"psql","-U","fixture","-d","canvas_test","-At"],{stdio:["pipe","pipe","pipe"]});
  const done=once(p,"exit");let output="";
  p.stdout.on("data",chunk=>{output+=chunk});
  p.stdin.write("BEGIN; LOCK TABLE canvas_projects IN ACCESS EXCLUSIVE MODE; SELECT 'fixture-locked';\n");
  await until(()=>output.includes("fixture-locked"));
  t.after(()=>{if(p.exitCode===null){p.stdin.end("ROLLBACK;\n");}});
  return async()=>{p.stdin.end("COMMIT;\n");await done;};
 };
 const unlock=await locked();
 const pending=request(f.front+"/api/v1/canvas/projects/fixture-board",{revision:1,title:"after-drain",document},"PUT");
 await until(()=>Number(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='canvas_lifecycle_fixture' AND wait_event_type='Lock'"))>0);
 docker("kill","--signal","SIGTERM",f.app);
 await until(()=>logs(f.app).includes("stopping frontend before API"));
 docker("kill","--signal","SIGTERM",f.app);
 await delay(150);
 assert.equal(docker("inspect","--format","{{.State.Running}}",f.app),"true","pending database write abandoned");
 await unlock();
 assert.equal((await pending).code,0,"frontend/API drain lost the write response");
 await until(()=>docker("inspect","--format","{{.State.Running}}",f.app)==="false");
 assert.equal(docker("inspect","--format","{{.State.ExitCode}}",f.app),"0");
 assert.equal(sql("SELECT revision||':'||title FROM canvas_projects WHERE id='fixture-board'"),"2:after-drain");
 assert.equal(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='canvas_lifecycle_fixture'"),"0");
 // Direct Go work remains tracked after its client disconnects; no pool close
 // while its non-context GORM query is waiting for a lock.
 f=await start("-detached");
 const release=await locked(),abort=new AbortController();
 const detached=fetch(f.api+"/api/v1/canvas/projects",{headers:headers(),signal:abort.signal}).catch(()=>{});
 await until(()=>Number(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='canvas_lifecycle_fixture' AND wait_event_type='Lock'"))>0);
 abort.abort();await detached;
 docker("kill","--signal","SIGTERM",f.app);
 await until(()=>logs(f.app).includes("draining HTTP and workers"));
 await delay(150);assert.equal(docker("inspect","--format","{{.State.Running}}",f.app),"true");
 await assert.rejects(fetch(f.api+"/api/healthz",{signal:AbortSignal.timeout(500)}));
 await release();
 await until(()=>docker("inspect","--format","{{.State.Running}}",f.app)==="false");
 assert.equal(docker("inspect","--format","{{.State.ExitCode}}",f.app),"0");
 assert.equal(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='canvas_lifecycle_fixture'"),"0");
 f=await start("-timeout");
 const timeoutRelease=await locked();
 const blocked=fetch(f.front+"/api/v1/canvas/projects",{headers:headers()}).catch(()=>{});
 await until(()=>Number(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='canvas_lifecycle_fixture' AND wait_event_type='Lock'"))>0);
 const hardStart=Date.now();docker("kill","--signal","SIGTERM",f.app);
 await until(()=>docker("inspect","--format","{{.State.Running}}",f.app)==="false",32_000);
 assert.equal(docker("inspect","--format","{{.State.ExitCode}}",f.app),"1","hard timeout must report failure");
 assert.ok(Date.now()-hardStart<30_000,"supervisor exceeded compose budget");
 assert.match(logs(f.app),/deadline exceeded/);
 await timeoutRelease();await blocked;
 await until(()=>sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='canvas_lifecycle_fixture'")==="0");
 f=await start("-idle");
 const idleStart=Date.now();docker("stop","--time","30",f.app);
 assert.equal(docker("inspect","--format","{{.State.ExitCode}}",f.app),"0");
 assert.ok(Date.now()-idleStart<3000,"idle image exceeded 3s");
 t.diagnostic("Actual Go+Next image: Node24 uid/gid1000, root-owned 0755 OSS mount unchanged, signed DB write durable, detached query drained, fresh requests refused, DB sessions zero, idle stop <3s; no business UI opened.");
});
