import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compactJob, presentOutput } from '../src/output.mjs';
const cli = fileURLToPath(new URL('../bin/claude-companion.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fake-claude.fixture.mjs', import.meta.url));

test('compact presentation keeps actionable evidence, failures and uncertainty without duplicate claims or internals', () => {
  const claims = { summary:'A unique conclusion', completion:'incomplete', changes:[], checks:[{command:'test',outcome:'failed',detail:'regression'}], uncertainties:['unknown SDK'], unverifiedClaims:['unverified rollout'] };
  const job = {id:'job',status:'incomplete',error:'blocked',childMayBeRunning:true,sessionId:'private-session',childPid:12,result:'duplicate prose',structuredOutput:claims,review:claims,evidence:{baseline:'internal'},reviewContext:{warnings:['binary skipped'],text:'huge diff'},report:{version:1,selection:{actualModels:['actual']},process:{success:true,status:'incomplete'},task:{independentlyVerified:false},claims,observed:{counts:{failed:1},partial:true,warnings:['snapshot partial'],actions:[{command:'long command'}],fileChanges:[{file:'app.js',change:'modified',before:'hash-before',after:'hash-after'}]},permissionDenials:[{tool_name:'Write'}],uncertainties:['unknown SDK','snapshot partial','blocked','extra uncertainty'],unverifiedClaims:['unverified rollout']}};
  const original = structuredClone(job);
  const compact = compactJob(job), json = JSON.stringify(compact);
  assert.deepEqual(job, original);
  assert.deepEqual(compact.report.claims,claims);
  assert.equal(compact.report.process.success,true);
  assert.equal(compact.report.task.independentlyVerified,false);
  assert.equal(compact.childMayBeRunning,true);
  assert.deepEqual(compact.report.observed.fileChanges,[{file:'app.js',change:'modified'}]);
  assert.deepEqual(compact.report.uncertainties,['extra uncertainty']);
  assert.deepEqual(compact.reviewContext.warnings,['binary skipped']);
  assert.equal(compact.report.permissionDenials[0].tool_name,'Write');
  assert.equal(json.split('A unique conclusion').length,2);
  for (const forbidden of ['private-session','duplicate prose','hash-before','hash-after','huge diff','long command','baseline','structuredOutput']) assert.ok(!json.includes(forbidden),forbidden);
  assert.equal(presentOutput('result',job,{full:true}),job);
});

test('status remains useful without transporting tool commands and process metadata', () => {
  const value = presentOutput('status',{id:'job',status:'running',cursor:42,childPid:1,summary:'working',events:[{sequence:42,type:'tool_finished',phase:'executing',tool:'Bash',failed:true,command:'long command',toolUseId:'internal'}],eventsTruncated:true,waitTimedOut:false});
  assert.deepEqual(value.events,[{sequence:42,type:'tool_finished',phase:'executing',tool:'Bash',failed:true}]);
  assert.equal(value.cursor,42);assert.equal(value.eventsTruncated,true);assert.ok(!('childPid' in value));
  assert.deepEqual(presentOutput('status',[{id:'job',status:'completed',ownerPid:4}]),[{id:'job',status:'completed'}]);
  const discovery={candidates:[],requiresExplicitJob:true};assert.equal(presentOutput('status',discovery),discovery);
  assert.equal(compactJob({result:'Legacy answer'}).result,'Legacy answer');
});

test('CLI defaults to compact results, --full retrieves original evidence, and failures stay incomplete', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-output-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'repo');fs.mkdirSync(cwd);
  const common=['--cwd',cwd,'--state-dir',path.join(root,'state')];
  const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{...process.env,CLAUDE_CODE_BINARY:fixture}});
  const task=run(['rescue',...common,'--prompt','Inspect']);
  assert.equal(task.status,0,task.stderr);
  const compact=JSON.parse(task.stdout);
  assert.equal(compact.report.claims.summary,'Fixture task');
  assert.equal(compact.report.task.independentlyVerified,false);
  assert.ok(!('result' in compact));assert.ok(!('structuredOutput' in compact));
  const fetched=run(['result',...common,'--job',compact.id]);
  const full=run(['result',...common,'--job',compact.id,'--full']);
  assert.equal(full.status,0,full.stderr);
  const diagnostic=JSON.parse(full.stdout);
  assert.ok(diagnostic.result);assert.ok(diagnostic.evidence.actions.length);assert.ok(diagnostic.sessionId);
  assert.ok(fetched.stdout.length < full.stdout.length * 0.5,`compact ${fetched.stdout.length}, full ${full.stdout.length}`);
  for (const prompt of ['FAILED_CHECK','DENIED','CLAIM_INCOMPLETE']) {
    const failed=run(['rescue',...common,'--prompt',prompt]);
    assert.equal(failed.status,1,failed.stderr);
    const value=JSON.parse(failed.stdout);assert.equal(value.status,'incomplete');
    if(prompt==='DENIED')assert.ok(value.report.permissionDenials.length);
    if(prompt==='FAILED_CHECK')assert.equal(value.report.claims.checks[0].outcome,'failed');
  }
  const invalid=run(['setup','--cwd',cwd,'--full']);assert.equal(invalid.status,1);assert.match(invalid.stderr,/not supported/);
});

const busy = (extra = {}) => ({
  id: 'job', kind: 'rescue', status: 'completed', cursor: 256, phase: 'completed',
  events: Array.from({ length: 256 }, (_, i) => ({ sequence: i + 1, type: i % 2 ? 'tool_finished' : 'tool_started', phase: 'investigating', tool: 'Read', failed: false, message: 'Using Read.', toolUseId: `tool-${i}`, path: `src/very/long/path/to/file-${i}.mjs`, at: '2026-11-01T00:00:00.000Z' })),
  report: { version: 1, process: { success: true, exitCode: 0, status: 'completed' }, task: { independentlyVerified: false }, claims: { summary: 'Done', completion: 'completed', changes: [], checks: [], uncertainties: [], unverifiedClaims: [] }, permissionDenials: [] },
  ...extra,
});
const TERMINAL_LIMIT = 2048;
test('terminal responses omit the event history and stay under 2 KiB even after 256 events', () => {
  const review = busy({ kind: 'review', reviewContext: { scope: 'working-tree', root: '/r', base: null, warnings: [] }, review: { findings: [] } });
  const cases = {
    successful: busy(),
    failed: busy({ status: 'failed', error: 'Claude exited without a final result.', failure: { kind: 'nonzero_exit', message: 'Claude exited with code 2' }, process: { exitCode: 2, signal: null, stderrTail: 'x'.repeat(4096), spawnError: null } }),
    cancelled: busy({ status: 'cancelled', phase: 'cancelled' }),
    pending: busy({ status: 'running', pending: true, partial: true, phase: 'investigating', report: undefined }),
    review,
  };
  for (const command of ['rescue', 'review', 'adversarial-review', 'result']) {
    for (const [name, job] of Object.entries(cases)) {
      const value = presentOutput(command, job), json = JSON.stringify(value);
      assert.ok(!('events' in value), `${command}/${name} replays events`);
      assert.ok(!json.includes('tool-1') && !json.includes('file-'), `${command}/${name} leaks event fields`);
      assert.ok(Buffer.byteLength(json) < TERMINAL_LIMIT, `${command}/${name} is ${Buffer.byteLength(json)} bytes`);
      assert.ok(Buffer.byteLength(JSON.stringify(job)) > 20_000);
    }
  }
  assert.equal(presentOutput('result', cases.failed).failure.kind, 'nonzero_exit');
  assert.equal(presentOutput('result', cases.failed).process.exitCode, 2);
  assert.ok(!JSON.stringify(presentOutput('result', cases.failed)).includes('xxxx'), 'stderr tail is --full only');
  assert.equal(presentOutput('result', cases.pending).status, 'running');
  assert.equal(presentOutput('review', cases.review).reviewContext.scope, 'working-tree');
});
test('cancel keeps its note, status keeps cursor-based events, and --full stays complete', () => {
  const cancel = presentOutput('cancel', { id: 'job', status: 'cancellation_requested', note: 'Wait for final status. Cancellation does not undo edits.' });
  assert.match(cancel.note, /does not undo edits/);
  const slice = busy().events.slice(250);
  const status = presentOutput('status', { id: 'job', status: 'running', cursor: 256, events: slice, eventsTruncated: false, waitTimedOut: false });
  assert.equal(status.events.length, 6); assert.equal(status.cursor, 256); assert.equal(status.eventsTruncated, false);
  const job = busy({ process: { exitCode: 2, signal: null, stderrTail: 'tail', spawnError: null } });
  assert.equal(presentOutput('result', job, { full: true }).events.length, 256);
  assert.equal(presentOutput('result', job, { full: true }).process.stderrTail, 'tail');
});
test('CLI terminal results omit events while --full and status keep them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-output-events-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  const common = ['--cwd', cwd, '--state-dir', path.join(root, 'state')];
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_BINARY: fixture } });
  const done = JSON.parse(run(['rescue', ...common, '--prompt', 'Inspect']).stdout);
  assert.ok(!('events' in done));
  assert.ok(!('events' in JSON.parse(run(['result', ...common, '--job', done.id]).stdout)));
  assert.ok(JSON.parse(run(['result', ...common, '--job', done.id, '--full']).stdout).events.length > 0);
  assert.ok(JSON.parse(run(['status', ...common, '--job', done.id]).stdout).events.length > 0);
  assert.equal(JSON.parse(run(['status', ...common, '--job', done.id, '--after', '999']).stdout).events.length, 0);
});

test('compact output shows a one-line usage aggregate, --full the per-model breakdown, and older jobs show none', () => {
  const usage = { inputTokens: 1200, outputTokens: 340, cacheReadTokens: null, cacheCreationTokens: 0, costUsd: 0.0123,
    byModel: { a: { inputTokens: 1000, outputTokens: 300, cacheReadTokens: null, cacheCreationTokens: 0, costUsd: 0.01 }, b: { inputTokens: 200, outputTokens: 40, cacheReadTokens: null, cacheCreationTokens: 0, costUsd: 0.0023 } } };
  const compact = presentOutput('result', busy({ usage }));
  assert.equal(compact.usage, 'tokens: 1200 in, 340 out, 0 cache write; reported cost: $0.0123 (2 models)');
  assert.ok(!JSON.stringify(compact).includes('byModel'));
  assert.deepEqual(presentOutput('result', busy({ usage }), { full: true }).usage.byModel.b, usage.byModel.b);
  assert.ok(!('usage' in presentOutput('result', busy())));
  assert.ok(!('usage' in presentOutput('result', busy({ usage: null }))));
  assert.ok(!('usage' in presentOutput('result', busy({ usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, byModel: {} } }))));
});
