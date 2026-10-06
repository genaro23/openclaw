if(process.env.ALLOW_LIVE_PREFS_PROOF!=='1') throw Error('Explicit live preference proof opt-in required');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=(process.env.PROOF_DIR ?? process.cwd());
const P='ui.workerHistory.entries',R='ui.workerHistory.retentionMinutes';
function url(){let raw=execFileSync((process.env.OPENCLAW_CLI ?? 'openclaw'),['dashboard','--json','--no-open'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});let u=new URL(JSON.parse(raw.slice(raw.indexOf('{'))).browserUrl);u.pathname='/systems';return u.href;}
const b=await chromium.launch({headless:true});let a,z,original,id,testRetention,lastName,ids=[],changed=false;const results={head:'079f019294fb87175e6f7371f0d5facb0e0df6a8',checks:{},limits:['Production Gateway was not restarted or upgraded.','Two separate Chromium contexts, not native clients.','Real existing terminal worker; no worker resource operations.']};
async function ready(p){await p.waitForFunction(()=>{const c=document.querySelector('openclaw-systems-page')?.routeData?.controller;return !!c?.context.gateway.snapshot.selfUser?.id&&c.canEditWorkerPreferences&&c.rows.length>0;},null,{timeout:30000});}
async function prefs(p){return p.locator('openclaw-systems-page').evaluate(el=>el.routeData.controller.context.gateway.snapshot.client.request('users.prefs.get',{}));}
async function check(p,condition,args){await p.waitForFunction(condition,args,{timeout:15000});}
try{
 a=await (await b.newContext()).newPage();await a.goto(url(),{waitUntil:'domcontentloaded'});await ready(a);
 z=await (await b.newContext()).newPage();await z.goto(url(),{waitUntil:'domcontentloaded'});await ready(z);
 const profile=async p=>p.locator('openclaw-systems-page').evaluate(e=>e.routeData.controller.context.gateway.snapshot.selfUser.id);
 assert.equal(await profile(a),await profile(z));results.checks.sameDurableProfile=true;
 const identity=async p=>p.locator('openclaw-systems-page').evaluate(e=>{const s=e.routeData.controller.context.gateway.snapshot;return {id:s.client.scopeUpgradeBinding?.deviceId,issuedToken:!!s.hello?.auth?.deviceToken};});
 const ia=await identity(a),iz=await identity(z);assert.ok(ia.id&&iz.id);assert.notEqual(ia.id,iz.id);assert.ok(ia.issuedToken&&iz.issuedToken);results.checks.distinctAuthenticatedDevices=true;

 original=await prefs(a);assert.equal(original.status,'ok');

 ids=await a.locator('openclaw-systems-page').evaluate(e=>{const c=e.routeData.controller;return c.rows.filter(r=>c.canDismissWorker(r)&&r.environment.worker.state==='destroyed').slice(0,2).map(r=>r.environment.id)});assert.equal(ids.length,2);
 assert.equal(Object.keys(original.entries[P]??{}).length,0,'Existing presentation customizations: use isolated proof instead');
 lastName='Sidebar concurrent proof — temporary';changed=true;
 let arrived=0,release;const gate=new Promise(r=>release=r);const timeout=setTimeout(()=>release(),10000);let conflicts=0;
 for(const page of [a,z]){
  await page.exposeFunction('proofSetGate',async()=>{arrived++;if(arrived===2){clearTimeout(timeout);release();}await gate;});
  await page.exposeFunction('proofConflict',()=>{conflicts++;});
  await page.locator('openclaw-systems-page').evaluate(e=>{const client=e.routeData.controller.context.gateway.snapshot.client;const request=client.request.bind(client);let first=true;client.request=async(method,params,...rest)=>{if(method==='users.prefs.set'&&first){first=false;await window.proofSetGate();}const result=await request(method,params,...rest);if(method==='users.prefs.set'&&result.status==='conflict')await window.proofConflict();return result;};});
 }
 await Promise.all([a,z].map((page,i)=>page.locator('openclaw-systems-page').evaluate(async(e,{id,name})=>{const c=e.routeData.controller;await c.renameWorker(id,name);if(c.workerHistoryError)throw Error('concurrent rename failed');},{id:ids[i],name:lastName})));
 assert.equal(arrived,2);assert.ok(conflicts>=1,'No actual CAS conflict observed');results.checks.realCasConflictObserved=true;
 for(const page of [a,z])await check(page,({ids,name})=>{const c=document.querySelector('openclaw-systems-page')?.routeData.controller;return ids.every(id=>c?.workerName(id)===name);},{ids,name:lastName});
 results.checks.bothConcurrentEditsRetainedOnBothClients=true;
 await z.reload({waitUntil:'domcontentloaded'});await ready(z);await check(z,({ids,name})=>{const c=document.querySelector('openclaw-systems-page')?.routeData.controller;return ids.every(id=>c?.workerName(id)===name);},{ids,name:lastName});results.checks.concurrentEditsSurviveClientReload=true;
 const after=await prefs(z);const unrelated=v=>Object.fromEntries(Object.entries(v).filter(([k])=>k!==P&&k!==R));assert.deepEqual(unrelated(after.entries),unrelated(original.entries));results.checks.unrelatedPreferencesUnchanged=true;

}catch(e){results.error=e.message;process.exitCode=1;}finally{
 if(changed&&a){try{const current=await prefs(a);const entries={};const map={...(current.entries[P]??{})};for(const workerId of ids)if(map[workerId]?.name===lastName)delete map[workerId];entries[P]=Object.keys(map).length?map:(original.entries[P]??null);if(testRetention!==undefined&&current.entries[R]===testRetention)entries[R]=original.entries[R]??null;const expectedEntries=Object.fromEntries(Object.keys(entries).map(k=>[k,current.entries[k]??null]));const restored=await a.locator('openclaw-systems-page').evaluate((e,p)=>e.routeData.controller.context.gateway.snapshot.client.request('users.prefs.set',p),{entries,expectedEntries});assert.equal(restored.status,'ok');const final=await prefs(a);assert.deepEqual(final.entries[P]??null,original.entries[P]??null);assert.deepEqual(final.entries[R]??null,original.entries[R]??null);results.checks.originalSettingsRestored=true;}catch(e){results.restoreError=e.message;process.exitCode=1;}}
 await fs.writeFile(out+'/live-concurrent-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));await b.close();
}
