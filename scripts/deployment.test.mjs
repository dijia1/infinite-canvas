import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const app = 'infinite-canvas', prefix = 'INFINITE_CANVAS';
const source = fileURLToPath(new URL('.', import.meta.url));
function command(cmd, args, options = {}) { const r = spawnSync(cmd, args, { encoding: 'utf8', ...options }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
async function fixture(t, fault = '') {
 const root = await mkdtemp(join(tmpdir(), app+'-deploy-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const repo = join(root,'repo'), appDir=join(root,'app'), stateDir=join(root,'state'), bin=join(root,'bin');
 await Promise.all([repo,appDir,stateDir,bin].map(p=>mkdir(p,{recursive:true})));
 command('git',['init','-q',repo]);
 const git=args=>command('git',['-C',repo,...args]);
 git(['config','user.email','deploy-test@invalid.local']);git(['config','user.name','Deployment Test']);
 const shas=[];
 for(let i=0;i<3;i++){await writeFile(join(repo,'docker-compose.yml'), 'services: {}\n# '+i);git(['add','.']);git(['commit','-qm','release '+i]);shas.push(git(['rev-parse','HEAD']));}
 const [old,baseline,target]=shas;
 for(const sha of shas){command('git',['-C',repo,'worktree','add','--detach',join(appDir,'releases',sha),sha]);}
 await writeFile(join(appDir,'.env'),'# isolated mock configuration\n');
 const image=sha=>'ghcr.io/dijia1/'+app+':sha-'+sha;
 const stateFile=join(stateDir,app+'-release.last-known-good');
 const baselineState=`version=2\ncurrent_sha=${baseline}\ncurrent_image=${image(baseline)}\ncurrent_release=${appDir}/releases/${baseline}\nprevious_sha=\nprevious_image=\nprevious_release=\n`;
 await writeFile(stateFile,baselineState,{mode:0o600});
 const modelFile=join(root,'docker.json'), actionsFile=join(root,'actions.jsonl');
 await writeFile(modelFile,JSON.stringify({active:image(baseline),baseline:image(baseline),target:image(target),old:image(old),fault}));
 await writeFile(join(bin,'flock'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const mock=`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),p=process.env.MOCK_MODEL,m=JSON.parse(fs.readFileSync(p));
fs.appendFileSync(process.env.MOCK_ACTIONS,JSON.stringify({args:a,image:process.env.${prefix}_IMAGE})+'\\n');
const fail=()=>process.exit(1),out=s=>{process.stdout.write(String(s)+'\\n');process.exit(0);};
const imageId=i=>'id-'+i.split(':sha-')[1];
if(a[0]==='compose'){
 const q=a.indexOf('-f')+2,cmd=a[q],image=process.env.${prefix}_IMAGE;
 if(cmd==='ps')out('app-container');
 if(cmd==='config'){if(m.fault==='config'&&image===m.target)fail();out('');}
 if(cmd==='run'){if(m.fault==='migration')fail();out('');}
 if(cmd==='up'){if(m.fault==='up'&&image===m.target)fail();m.active=image;fs.writeFileSync(p,JSON.stringify(m));out('');}
 fail();
}
if(a[0]==='pull'){if(m.fault==='pull'&&a[1]===m.target)fail();out('');}
if(a[0]==='image'&&a[1]==='inspect')out(imageId(a.at(-1)));
if(a[0]==='inspect'){
 const f=a[a.indexOf('--format')+1];
 if(f==='{{.Image}}')out(a.at(-1)==='stopped-container'?imageId(m.old):imageId(m.active));
 if(f==='{{.Config.Image}}')out(m.fault==='image'&&m.active===m.target?'wrong:image':m.active);
 if(f.includes('.State.Status'))out(m.fault==='baseline-unhealthy'&&m.active===m.baseline?'running unhealthy':'running healthy');
 fail();
}
if(a[0]==='exec'){if(m.fault==='gateway-baseline'&&m.active===m.baseline||m.fault==='gateway-target'&&m.active===m.target)fail();out('');}
if(a[0]==='ps')out('app-container\\nstopped-container');
if(a[0]==='image'&&a[1]==='ls')out(m.baseline+' '+imageId(m.baseline)+'\\n'+m.target+' '+imageId(m.target)+'\\n'+m.old+' '+imageId(m.old)+'\\n'+m.old.slice(0,-40)+'f'.repeat(40)+' id-garbage\\nghcr.io/other/app:sha-'+ 'f'.repeat(40)+' id-other');
if(a[0]==='image'&&a[1]==='rm')out('removed');
fail();
`;
 // Garbage inspection must return the same image ID used by enumeration.
 await writeFile(join(bin,'docker'),mock.replace("if(a[0]==='image'&&a[1]==='inspect')out(imageId(a.at(-1)));", "if(a[0]==='image'&&a[1]==='inspect')out(a.at(-1).endsWith('f'.repeat(40))?'id-garbage':imageId(a.at(-1)));"),{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,[prefix+'_APP_DIR']:appDir,[prefix+'_RELEASE_STATE_DIR']:stateDir,[prefix+'_MEDIA_DIR']:join(root,'media'),MOCK_MODEL:modelFile,MOCK_ACTIONS:actionsFile,DEPLOY_HEALTH_ATTEMPTS:'1',DEPLOY_HEALTH_INTERVAL:'0'};
 const deploy=()=>spawnSync('bash',[join(source,'deploy-production.sh'),target,image(target),join(appDir,'releases',target)],{env,encoding:'utf8'});
 const actions=async()=>{try{return(await readFile(actionsFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return[];}};
 return {root,repo,appDir,stateDir,stateFile,baselineState,old,baseline,target,image,deploy,actions,model:async()=>JSON.parse(await readFile(modelFile,'utf8'))};
}
test('successful release migrates before up and records current/previous atomically',async t=>{
 const f=await fixture(t),r=f.deploy();assert.equal(r.status,0,r.stderr);
 const a=await f.actions(),run=a.findIndex(x=>x.args.includes('run')),up=a.findIndex(x=>x.args.includes('up'));
 assert.ok(run>=0&&up>run);assert.ok(a[run].args.includes('--no-deps'));assert.ok(a[up].args.includes('--no-build'));
 const state=await readFile(f.stateFile,'utf8');assert.ok(state.includes('current_sha='+f.target));assert.ok(state.includes('previous_sha='+f.baseline));
 assert.equal((await f.model()).active,f.image(f.target));
 const {stat}=await import('node:fs/promises');assert.equal((await stat(f.stateFile)).mode&0o777,0o600);
});
for(const fault of ['pull','migration','config','up','gateway-target','image'])test(fault+' failure restores baseline image/config, exits nonzero and preserves state',async t=>{
 const f=await fixture(t,fault),r=f.deploy();assert.notEqual(r.status,0);
 assert.equal((await f.model()).active,f.image(f.baseline));assert.equal(await readFile(f.stateFile,'utf8'),f.baselineState);
 const a=await f.actions();assert.ok(a.some(x=>x.args.includes('up')&&x.image===f.image(f.baseline)));
 if(fault==='migration')assert.ok(!a.some(x=>x.args.includes('up')&&x.image===f.image(f.target)));
});
for(const fault of ['baseline-unhealthy','gateway-baseline'])test(fault+' aborts before target pull/migration/up',async t=>{
 const f=await fixture(t,fault);assert.notEqual(f.deploy().status,0);const a=await f.actions();assert.ok(!a.some(x=>x.args[0]==='pull'||x.args.includes('run')||x.args.includes('up')));
});
test('missing or invalid baseline and missing target commit are refused',async t=>{
 const f=await fixture(t);await rm(f.stateFile);assert.notEqual(f.deploy().status,0);assert.equal((await f.actions()).length,0);
 await writeFile(f.stateFile,'current_sha=invalid\n');assert.notEqual(f.deploy().status,0);
 await writeFile(f.stateFile,f.baselineState);await rm(join(f.appDir,'releases',f.target,'.git'));assert.notEqual(f.deploy().status,0);assert.equal((await f.actions()).length,0);
});
test('dirty tracked target config is refused without touching running service',async t=>{
 const f=await fixture(t);await writeFile(join(f.appDir,'releases',f.target,'docker-compose.yml'),'changed');assert.notEqual(f.deploy().status,0);assert.equal((await f.actions()).length,0);
});
test('cleanup protects baseline, target, stopped containers and other repositories',async t=>{
 const f=await fixture(t),r=f.deploy();assert.equal(r.status,0,r.stderr);
 const removed=(await f.actions()).filter(x=>x.args[0]==='image'&&x.args[1]==='rm').map(x=>x.args[2]);
 assert.deepEqual(removed,[f.image('f'.repeat(40))]);
});
