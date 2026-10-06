const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const OUT=(process.env.PROOF_DIR ?? process.cwd());
const BASE=process.env.OPENCLAW_PROOF_HEAD;
const HEAD=process.env.OPENCLAW_PROOF_HEAD;
const NODE=(process.env.PROOF_NODE ?? process.execPath);
const state=await fs.mkdtemp(path.join(os.tmpdir(),'sidebar-upgrade-proof-'));await fs.chmod(state,0o700);
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!(/^(OPENCLAW_|OPENAI_|ANTHROPIC_|GH_TOKEN|GITHUB_TOKEN)/.test(k))));
Object.assign(env,{OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:path.join(state,'openclaw.json'),OPENCLAW_GATEWAY_TOKEN:crypto.randomBytes(32).toString('hex'),OPENCLAW_SKIP_CHANNELS:'1',OPENCLAW_SKIP_CRON:'1',OPENCLAW_SKIP_PROVIDERS:'1',OPENCLAW_SKIP_GMAIL_WATCHER:'1',OPENCLAW_SKIP_BROWSER_CONTROL_SERVER:'1',OPENCLAW_SKIP_CANVAS_HOST:'1'});
await fs.writeFile(env.OPENCLAW_CONFIG_PATH,JSON.stringify({gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token'},controlUi:{enabled:true,allowedOrigins:[`http://127.0.0.1:${port}`]}},plugins:{enabled:false},agents:{defaults:{workspace:path.join(state,'workspace')}}}),{mode:0o600});
let proc,browser;const results={checks:{},limits:['No production state, service, plugin links, or ports modified.','Uses retained installed parent/candidate binaries; no resource/provider operations.','Fresh isolated candidate profile; no synthetic worker row needed.']};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function boot(root){proc=spawn(NODE,[path.join(root,'dist/index.js'),'gateway','run','--port',String(port),'--bind','loopback'],{env,stdio:['ignore','pipe','pipe']});let logs='';proc.stdout.on('data',x=>{logs=(logs+x).slice(-12000);});proc.stderr.on('data',x=>{logs=(logs+x).slice(-12000);});for(let i=0;i<90;i++){if(proc.exitCode!==null){await fs.writeFile(path.join(state,'failed-startup.log'),logs,{mode:0o600});throw Error('Isolated Gateway exited '+proc.exitCode+'; private startup log retained');}try{const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});if(r.ok){console.log('Isolated build ready:',path.basename(path.dirname(path.dirname(root))));return;}}catch{}await delay(500);}throw Error('Isolated readiness timeout');}
async function stop(){if(!proc||proc.exitCode!==null)return;proc.kill('SIGTERM');for(let i=0;i<60&&proc.exitCode===null;i++)await delay(500);if(proc.exitCode===null){proc.kill('SIGKILL');await new Promise(r=>proc.once('exit',r));}proc=null;}
function login(root){const raw=execFileSync(NODE,[path.join(root,'openclaw.mjs'),'dashboard','--json','--no-open'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});const d=JSON.parse(raw.slice(raw.indexOf('{')));const u=new URL(d.browserUrl);assert.equal(Number(u.port),port);u.pathname='/systems';return u.href;}
async function ready(p){await p.waitForFunction(()=>!!document.querySelector('openclaw-systems-page')?.routeData?.controller?.context.gateway.snapshot.selfUser?.id,null,{timeout:45000});}
async function rpc(p,method,params){return p.locator('openclaw-systems-page').evaluate((e,{method,params})=>e.routeData.controller.context.gateway.snapshot.client.request(method,params),{method,params});}
async function identity(p){return p.locator('openclaw-systems-page').evaluate(e=>{const s=e.routeData.controller.context.gateway.snapshot;return {profile:s.selfUser.id,device:s.client.scopeUpgradeBinding?.deviceId,authenticated:!!s.hello?.auth?.deviceToken};});}
try{
 results.head=JSON.parse(await fs.readFile(path.join(HEAD,'dist/build-info.json'),'utf8')).commit;assert.equal(results.head,'079f019294fb87175e6f7371f0d5facb0e0df6a8');
 await boot(HEAD);browser=await chromium.launch({headless:true});const a=await(await browser.newContext()).newPage();await a.goto(login(HEAD),{waitUntil:'domcontentloaded'});await ready(a);
 const fresh=await rpc(a,'users.prefs.get',{});assert.equal(fresh.status,'ok');assert.equal(fresh.entries['ui.workerHistory.entries'],undefined);assert.equal(fresh.entries['ui.workerHistory.retentionMinutes'],undefined);results.checks.freshProfileHasNoFeaturePreferences=true;
 assert.equal(await a.locator('openclaw-systems-page').evaluate(e=>e.routeData.controller.historyRetentionMinutes),15);results.checks.freshProfileDefaultsTo15Minutes=true;
 await a.locator('openclaw-systems-page').evaluate(async e=>{const c=e.routeData.controller;await c.setHistoryRetentionMinutes(10);if(c.workerHistoryError)throw Error('Fresh profile writer failed');});await a.reload({waitUntil:'domcontentloaded'});await ready(a);assert.equal((await rpc(a,'users.prefs.get',{})).entries['ui.workerHistory.retentionMinutes'],10);results.checks.freshProfileWriterPersistsAcrossReload=true;

}catch(e){results.error=e.message;process.exitCode=1;}finally{if(browser)await browser.close();await stop();results.checks.ownedGatewayStopped=true;if(!results.error){await fs.rm(state,{recursive:true,force:true});results.checks.disposableStateRemoved=true;}else{results.retainedState=state;}await fs.writeFile(OUT+'/fresh-profile-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));}
