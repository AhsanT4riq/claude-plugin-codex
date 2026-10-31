import {waitForReady,executionFromReadiness,backgroundExecutionFromReadiness} from './fake-claude.fixture.mjs';
import {readJob} from '../src/state.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {buildClaudeArgs,delegate,launchBackground,resultJob,workspaceStore} from '../src/runtime.mjs';
import {selection,selectionOptions} from '../src/options.mjs';
const fixture=fileURLToPath(new URL('./fake-claude.fixture.mjs',import.meta.url));const cli=fileURLToPath(new URL('../bin/claude-companion.mjs',import.meta.url));
function context(t){
 backgroundExecutionFromReadiness(t);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-options-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cwd=path.join(root,'repo');fs.mkdirSync(cwd);const stateDir=path.join(root,'state');let current;
 executionFromReadiness(t,cwd,()=>current&&readJob(current.store,current.id).childPid);
 return {cwd,stateDir,binary:fixture,kind:'rescue',prompt:'Inspect',timeoutMs:3000,onJob(job){current={id:job.id,store:workspaceStore(cwd,stateDir)};}};
}
const arg=(args,name)=>args[args.indexOf(name)+1];
async function finish(store,id){for(let i=0;i<300;i++){const j=resultJob(store,id);if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,25));}throw new Error('Fixture worker timeout');}
test('named access profiles map exactly to scoped tools without bypassing approvals',()=>{
 assert.equal(selection().effort,'medium');
 assert.equal(arg(buildClaudeArgs({kind:'rescue'}),'--effort'),'medium');
 const expected={'read-only':'Read,Glob,Grep',edit:'Read,Glob,Grep,Edit,Write',shell:'Read,Glob,Grep,Edit,Write,Bash'};
 for(const [access,tools]of Object.entries(expected)){const args=buildClaudeArgs({kind:'rescue',access,model:'sonnet',effort:'high'});assert.equal(arg(args,'--tools'),tools);assert.equal(arg(args,'--allowedTools'),tools);assert.equal(arg(args,'--permission-mode'),'dontAsk');assert.equal(arg(args,'--permission-prompts'),'none');assert.equal(arg(args,'--model'),'sonnet');assert.equal(arg(args,'--effort'),'high');assert.ok(!args.includes('--dangerously-skip-permissions'));}
 assert.throws(()=>buildClaudeArgs({kind:'rescue',access:'read-only',write:true}),/conflicts/);assert.throws(()=>buildClaudeArgs({kind:'rescue',access:'edit',allowBash:true}),/conflicts/);
 assert.deepEqual(buildClaudeArgs({kind:'rescue',access:'shell'}),buildClaudeArgs({kind:'rescue',write:true,allowBash:true}));
});
test('model, effort and access validation happens before creating or launching a job',async t=>{
 const o=context(t);for(const changes of [{access:'full'},{model:''},{model:'--dangerously-skip-permissions'},{model:'model with spaces'},{effort:'invalid'}])await assert.rejects(delegate({...o,...changes}),/access|model|effort/);
 assert.equal(selection({model:'provider/model@20260101'}).model,'provider/model@20260101');
 assert.equal((await delegate(o)).status,'completed');
 for(const kind of ['review','adversarial-review'])for(const access of ['edit','shell'])await assert.rejects(delegate({...o,kind,access}),/Review commands/);
});
test('edit profile authorizes fixture edits; read-only profile does not',async t=>{
 const o=context(t);const readonly=await delegate({...o,access:'read-only',prompt:'WRITE_FILE',model:'haiku',effort:'low'});assert.equal(readonly.access,'read-only');assert.equal(fs.existsSync(path.join(o.cwd,'delegated.txt')),false);
 const edit=await delegate({...o,access:'edit',prompt:'WRITE_FILE'});assert.equal(edit.write,true);assert.equal(edit.allowBash,false);assert.equal(fs.readFileSync(path.join(o.cwd,'delegated.txt'),'utf8'),'fixture implementation\n');assert.equal(edit.approvalMode,'preapproved-scope');
});
test('continuation inherits model/effort while access resets; explicit defaults clear prior overrides',async t=>{
 const o=context(t),a=await delegate({...o,access:'shell',model:'chosen-model',effort:'max'});
 const b=await delegate({...o,resume:a.id});assert.equal(b.model,'chosen-model');assert.equal(b.effort,'max');assert.equal(b.access,'read-only');
 const c=await delegate({...o,resume:b.id,model:'default',effort:'default',access:'edit'});assert.equal(c.model,'claude-opus-5-5');assert.equal(c.effort,'medium');assert.equal(c.access,'edit');assert.equal(arg(JSON.parse(c.result).args,'--effort'),'medium');
 const d=await delegate({...o,resume:c.id});assert.equal(d.effort,'medium');assert.equal(d.access,'read-only');assert.equal(d.sessionId,a.sessionId);
});
test('background acknowledgment and stored result expose the effective selections',async t=>{
 const o=context(t);const ack=await launchBackground({...o,prompt:'WAIT',access:'shell',model:'sonnet',effort:'medium'});assert.equal(ack.model,'sonnet');assert.equal(ack.effort,'medium');assert.equal(ack.access,'shell');assert.equal(ack.approvalMode,'preapproved-scope');
 const store=workspaceStore(o.cwd,o.stateDir);const ready=await waitForReady(o.cwd,()=>readJob(store,ack.id).childPid);ready.release();
 const job=await finish(store,ack.id);assert.equal(job.status,'completed');assert.equal(job.report.selection.access,'shell');assert.equal(job.report.selection.model,'sonnet');assert.equal(job.report.selection.effort,'medium');
});
test('CLI options and setup expose choices; delegation accepts the selected profile',t=>{
 const o=context(t);const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{...process.env,CLAUDE_CODE_BINARY:fixture}});
 const catalog=JSON.parse(run(['options']).stdout);assert.deepEqual(catalog.access.choices,['read-only','edit','shell']);assert.equal(catalog.approval.mode,'preapproved-scope');
 const setup=run(['setup','--cwd',o.cwd,'--model','sonnet','--effort','high','--access','edit']);assert.equal(setup.status,0,setup.stderr);const ready=JSON.parse(setup.stdout);assert.equal(ready.modelAccessVerified,false);assert.equal(ready.access,'edit');assert.equal(ready.effort,'high');
 const task=run(['rescue','--cwd',o.cwd,'--state-dir',o.stateDir,'--model','sonnet','--effort','high','--access','shell','--prompt','Inspect']);assert.equal(task.status,0,task.stderr);assert.equal(JSON.parse(task.stdout).access,'shell');
 const bad=run(['rescue','--cwd',o.cwd,'--access','full','--prompt','Inspect']);assert.equal(bad.status,1);assert.match(bad.stderr,/access/);
 assert.equal(selectionOptions().effort.default,'medium');assert.equal(selection({effort:'default'},{effort:'max'}).effort,'medium');
});
