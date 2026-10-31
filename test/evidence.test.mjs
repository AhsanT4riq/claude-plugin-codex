import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {delegate,launchBackground,cancelJob,resultJob,workspaceStore} from '../src/runtime.mjs';
import {snapshot,startEvidence,observe,finishEvidence,resultContract} from '../src/evidence.mjs';
import {streamCollector} from '../src/stream.mjs';
const fixture=fileURLToPath(new URL('./fake-claude.fixture.mjs',import.meta.url));
function context(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-evidence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);return {cwd,stateDir:path.join(root,'state'),binary:fixture,kind:'rescue',prompt:'Inspect',timeoutMs:3000};}
async function until(fn){for(let i=0;i<400;i++){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,25));}throw new Error('Fixture timeout');}
test('observed file hashes and claims are separate; successful exit never independently verifies a task',async t=>{
 const o=context(t);const j=await delegate({...o,write:true,prompt:'WRITE_FILE'});assert.equal(j.status,'completed');assert.equal(j.report.version,1);assert.equal(j.report.process.success,true);assert.equal(j.report.task.claimedCompletion,'completed');assert.equal(j.report.task.independentlyVerified,false);assert.equal(j.report.task.coordinatorEvaluationRequired,true);
 assert.ok(j.evidence.fileChanges.some(f=>f.file==='delegated.txt'&&f.change==='added'&&f.after));assert.deepEqual(j.report.claims.changes,[]);assert.ok(j.evidence.counts.started>0);assert.ok(!JSON.stringify(j.evidence).includes('fixture implementation'));
});
test('claims of incomplete work and failed checks override process success',async t=>{
 const o=context(t);for(const prompt of ['CLAIM_INCOMPLETE','FAILED_CHECK']){const j=await delegate({...o,prompt});assert.equal(j.status,'incomplete');assert.equal(j.report.process.success,true);assert.equal(j.report.task.independentlyVerified,false);}
 const invalid=await delegate({...o,prompt:'BAD_SCHEMA'});assert.equal(invalid.status,'failed');assert.equal(invalid.report.process.success,true);assert.match(invalid.error,/Invalid structured/);
});
test('permission denials and timeout preserve incomplete evidence',async t=>{
 const o=context(t);const denied=await delegate({...o,prompt:'DENIED'});assert.equal(denied.status,'incomplete');assert.ok(denied.report.permissionDenials.length);assert.equal(denied.evidence.partial,true);
 const ack=await launchBackground({...o,prompt:'WRITE_THEN_HANG',write:true});const store=workspaceStore(o.cwd,o.stateDir);
 await until(()=>fs.existsSync(path.join(o.cwd,'partial.txt')));cancelJob(store,ack.id);
 const cancelled=await until(()=>{const j=resultJob(store,ack.id);return !['running','queued'].includes(j.status)&&j;});
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.report.task.claimedCompletion,'unknown');assert.equal(cancelled.evidence.partial,true);assert.ok(cancelled.evidence.fileChanges.some(f=>f.file==='partial.txt'));assert.equal(fs.readFileSync(path.join(o.cwd,'partial.txt'),'utf8'),'partial edit\n');
});
test('stream evidence captures selected metadata, tool failures and no raw bodies or reasoning',()=>{
 const e={actions:[],counts:{started:0,finished:0,failed:0,permissionDenied:0}};const s=streamCollector({onActivity:a=>observe(e,a)});const send=x=>s.line(JSON.stringify(x));
 send({type:'assistant',message:{content:[{type:'thinking',thinking:'SECRET'},{type:'tool_use',id:'x',name:'Bash',input:{command:'npm test',other:'SECRET'}}]}});
 send({type:'user',tool_use_result:{exitCode:1},message:{content:[{type:'tool_result',tool_use_id:'x',is_error:true,content:'SECRET'}]}});
 send({type:'system',subtype:'permission_denied',tool_name:'Write'});
 assert.equal(e.actions[0].command,'npm test');assert.equal(e.actions[0].outcome,'tool_reported_error');assert.equal(e.actions[0].exitCode,1);assert.equal(e.counts.permissionDenied,1);assert.ok(!JSON.stringify(e).includes('SECRET'));
});
test('file comparison detects additions, modifications and deletions without attributing external changes',t=>{
 const o=context(t);fs.writeFileSync(path.join(o.cwd,'change'),'before');fs.writeFileSync(path.join(o.cwd,'delete'),'before');const job={status:'completed',evidence:startEvidence(o.cwd)};
 fs.writeFileSync(path.join(o.cwd,'change'),'after');fs.unlinkSync(path.join(o.cwd,'delete'));fs.writeFileSync(path.join(o.cwd,'add'),'after');finishEvidence(job,o.cwd);
 assert.deepEqual(job.evidence.fileChanges.map(f=>f.change).sort(),['added','deleted','modified']);assert.match(job.evidence.attribution,/cannot be attributed/);assert.equal('baseline' in job.evidence,false);
});
test('bounded evidence reports its coverage and truncation explicitly',t=>{
 const o=context(t);fs.writeFileSync(path.join(o.cwd,'large'),Buffer.alloc(1024*1024+1));const baseline=snapshot(o.cwd);assert.equal(baseline.complete,false);assert.equal(baseline.files.large.sha256,null);
 const e=startEvidence(o.cwd);for(let i=0;i<600;i++)observe(e,{type:'tool_started',tool:'Read',toolUseId:String(i),path:'file'});assert.equal(e.actions.length,512);assert.equal(e.actionsTruncated,true);assert.equal(e.counts.started,600);
 const legacy=resultContract({status:'completed'});assert.equal(legacy.process.success,null);assert.equal(legacy.task.claimedCompletion,'unknown');assert.equal(legacy.task.independentlyVerified,false);
});

test('read-only workspace changes are reported conservatively without blaming Claude',async t=>{
 const o=context(t);const job=await delegate({...o,onJob(){fs.writeFileSync(path.join(o.cwd,'external-change'),'external editor');}});
 assert.equal(job.status,'incomplete');assert.equal(job.evidence.partial,true);assert.match(job.error,/attribution is not proven/);assert.equal(job.report.task.claimedCompletion,'completed');assert.equal(job.report.task.independentlyVerified,false);
});
