import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildClaudeArgs, delegate, workspaceStore, listJobs, readJob, runProcess, setup, cancelJob } from '../src/runtime.mjs';

const fixture = fileURLToPath(new URL('./fake-claude.fixture.mjs', import.meta.url));
function context(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bridge-test-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const cwd = path.join(root,'repo'); fs.mkdirSync(cwd);
  return {cwd,stateDir:path.join(root,'state'),binary:fixture,kind:'rescue',prompt:'Inspect the fixture',timeoutMs:3000};
}

test('read-only capability set excludes command and write tools', () => {
  const args=buildClaudeArgs({kind:'review'});
  assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--restricted'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});
test('permission escalation is explicit and forbidden in review', () => {
  assert.throws(()=>buildClaudeArgs({kind:'rescue',allowBash:true}),/requires --write/);
  assert.throws(()=>buildClaudeArgs({kind:'review',write:true}),/do not allow/);
  const args=buildClaudeArgs({kind:'rescue',write:true,allowBash:true});
  assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep,Edit,Write,Bash');
});
test('task text is sent as data and completion is stored', async t => {
  const options=context(t); options.prompt='--dangerously-skip-permissions $(touch owned) `touch owned`';
  const job=await delegate(options);
  assert.equal(job.status,'completed');
  assert.ok(JSON.parse(job.result).prompt.includes(options.prompt));
  assert.ok(!JSON.parse(job.result).args.includes(options.prompt));
  assert.equal(fs.existsSync(path.join(options.cwd,'owned')),false);
  const stored=readJob(workspaceStore(options.cwd,options.stateDir),job.id);
  const {lockToken,...publicStored}=stored; assert.ok(lockToken); assert.deepEqual(publicStored,job);
});
test('follow-up resumes the exact stored session and permits explicit rescue write access', async t => {
  const options=context(t); const initial=await delegate(options);
  const follow=await delegate({...options,prompt:'Revise your proposal',resume:initial.id});
  assert.equal(follow.status,'completed');
  assert.equal(follow.sessionId,initial.sessionId);
  assert.equal(follow.parentJobId,initial.id);
  assert.equal(JSON.parse(follow.result).resumed,true);
  const implemented=await delegate({...options,resume:follow.id,write:true,prompt:'WRITE_FILE'});
  assert.equal(implemented.sessionId,initial.sessionId);
  assert.equal(implemented.rootJobId,initial.id);
  assert.equal(fs.readFileSync(path.join(options.cwd,'delegated.txt'),'utf8'),'fixture implementation\n');
});
test('concurrent delegation cannot edit the same workspace', async t => {
  const options=context(t); let ready;
  const started=new Promise(resolve=>{ready=resolve;});
  const first=delegate({...options,prompt:'HANG',timeoutMs:100,onJob:ready});
  await started;
  await assert.rejects(delegate(options),/workspace lock/);
  assert.equal((await first).status,'timed_out');
  assert.equal((await delegate(options)).status,'completed');
});
test('malformed and null output fail; errors cannot become success', async t => {
  const options=context(t);
  for (const prompt of ['BAD_JSON','NULL_JSON','FAIL']) {
    assert.equal((await delegate({...options,prompt})).status,'failed');
  }
});
test('permission denials produce an incomplete job', async t => {
  const job=await delegate({...context(t),prompt:'DENIED'});
  assert.equal(job.status,'incomplete'); assert.equal(job.permissionDenials.length,1);
});
test('write access enables an implementation; read-only fixture remains unchanged', async t => {
  const options=context(t);
  await delegate({...options,prompt:'WRITE_FILE'});
  assert.equal(fs.existsSync(path.join(options.cwd,'delegated.txt')),false);
  const job=await delegate({...options,prompt:'WRITE_FILE',write:true});
  assert.equal(job.status,'completed');
  assert.equal(fs.readFileSync(path.join(options.cwd,'delegated.txt'),'utf8'),'fixture implementation\n');
});
test('state isolation and invalid job references', async t => {
  const options=context(t); const job=await delegate(options);
  const other=path.join(options.cwd,'other'); fs.mkdirSync(other);
  const store=workspaceStore(other,options.stateDir);
  assert.deepEqual(listJobs(store),[]);
  assert.throws(()=>readJob(store,job.id),/ENOENT/);
  assert.throws(()=>readJob(store,'../../secret'),/exact job UUID/);
});
test('missing binary fails without leaving a workspace lock', async t => {
  const options=context(t);
  await assert.rejects(delegate({...options,binary:path.join(options.cwd,'missing')}),e=>e.failure.kind==='missing_cli'&&/not found/.test(e.message));
  assert.equal((await delegate(options)).status,'completed');
});
test('diagnostics omit personal account metadata and do not claim model verification', t => {
  const options=context(t); const result=setup(fixture,options.cwd);
  assert.equal(result.loggedIn,true); assert.equal(result.modelAccessVerified,false);
  assert.equal(result.binary.path,fixture); assert.equal(result.binary.compatible,true); assert.deepEqual(result.binary.missingCapabilities,[]);
  assert.equal('email' in result,false);
});
test('runProcess aborts and limits output', async t => {
  const {cwd}=context(t);
  const controller=new AbortController();
  setTimeout(()=>controller.abort(),100);
  const output=await runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd,input:'',timeoutMs:3000,signal:controller.signal});
  assert.equal(output.reason,'cancelled');
  const large=await runProcess(process.execPath,['-e','console.log("x".repeat(10000))'],{cwd,input:'',timeoutMs:3000,maxBytes:100});
  assert.equal(large.reason,'output_limit');
});
test('CLI cancellation targets its owning delegation and records cancellation', async t => {
  const options=context(t);
  const cli=fileURLToPath(new URL('../bin/claude-companion.mjs',import.meta.url));
  const child=spawn(process.execPath,[cli,'rescue','--cwd',options.cwd,'--state-dir',options.stateDir,'--prompt','HANG'],{
    env:{...process.env,CLAUDE_CODE_BINARY:fixture},stdio:['ignore','pipe','pipe'],
  });
  t.after(()=>{try{child.kill('SIGTERM');}catch{}});
  let output=''; child.stdout.on('data',chunk=>output+=chunk);
  const finished=new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});
  const announcement=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('CLI did not announce a job')),3000);
    child.stderr.once('data',chunk=>{clearTimeout(timer);resolve(JSON.parse(chunk.toString()));});
  });
  const store=workspaceStore(options.cwd,options.stateDir);
  const cancellation=cancelJob(store,announcement.id);
  assert.equal(cancellation.status,'cancellation_requested');
  assert.equal(await finished,1);
  assert.equal(JSON.parse(output).status,'cancelled');
  assert.equal(readJob(store,announcement.id).status,'cancelled');
});
test('nested directories in one Git checkout share a lock and job namespace', async t => {
  const options=context(t);
  const git=await runProcess('git',['init','-b','main',options.cwd],{cwd:options.cwd,input:'',timeoutMs:3000});
  assert.equal(git.code,0);
  const nested=path.join(options.cwd,'src');fs.mkdirSync(nested);
  assert.equal(workspaceStore(options.cwd,options.stateDir).dir,workspaceStore(nested,options.stateDir).dir);
});
test('resume preserves a non-default explicit model', async t => {
  const options=context(t);
  const a=await delegate({...options,model:'explicit-model'});
  const b=await delegate({...options,resume:a.id});
  assert.equal(b.model,'explicit-model');
  const args=JSON.parse(b.result).args;
  assert.equal(args[args.indexOf('--model')+1],'explicit-model');
});

const failures = fileURLToPath(new URL('./fake-claude-failures.fixture.mjs', import.meta.url));
const failing = (t, prompt) => ({ ...context(t), binary: failures, prompt });
test('nonzero exit keeps exit code and sanitized stderr instead of a generic message', async t => {
  const job = await delegate(failing(t, 'EXIT2'));
  assert.equal(job.status, 'failed');
  assert.equal(job.failure.kind, 'nonzero_exit');
  assert.match(job.failure.message, /code 2.*DISTINCTIVE_STDERR_DIAGNOSTIC/);
  assert.equal(job.process.exitCode, 2); assert.equal(job.process.signal, null); assert.equal(job.process.spawnError, null);
  assert.match(job.process.stderrTail, /DISTINCTIVE_STDERR_DIAGNOSTIC/);
  assert.ok(!/SECRETSECRET|abcdef123456/.test(job.process.stderrTail), job.process.stderrTail);
  assert.ok(Buffer.byteLength(job.process.stderrTail) <= 4096);
  assert.equal(job.exitCode, 2); assert.equal(job.error, 'Claude exited without a final result.');
});
test('stderr tail is bounded to 4 KiB and keeps the end of the output', async t => {
  const options = failing(t, 'EXIT2');
  const noisy = path.join(path.dirname(options.cwd), 'noisy.mjs');
  fs.writeFileSync(noisy, `#!/usr/bin/env node\nimport fs from 'node:fs';\nif(process.argv.includes('--version'))console.log('2.1.292');else{fs.readFileSync(0);console.error('x'.repeat(10000)+'\\nTAIL_MARKER');process.exitCode=3;}\n`, { mode: 0o755 });
  const job = await delegate({ ...options, binary: noisy });
  assert.equal(job.process.exitCode, 3);
  assert.ok(Buffer.byteLength(job.process.stderrTail) <= 4096);
  assert.ok(job.process.stderrTail.endsWith('TAIL_MARKER'));
});
test('exit 0 without a final envelope is no_result, never completed', async t => {
  const job = await delegate(failing(t, 'NO_RESULT'));
  assert.equal(job.status, 'failed'); assert.equal(job.failure.kind, 'no_result');
  assert.equal(job.process.exitCode, 0);
});
test('invalid stream JSON is malformed_result and keeps the exit outcome', async t => {
  const job = await delegate(failing(t, 'INVALID_JSON'));
  assert.equal(job.status, 'failed'); assert.equal(job.failure.kind, 'malformed_result');
  assert.ok(job.process, 'process outcome persisted');
});
test('an interrupted stream keeps the signal and leaves the exit code unknown', async t => {
  const options = failing(t, 'INTERRUPTED');
  const job = await delegate(options);
  assert.equal(job.status, 'failed'); assert.equal(job.failure.kind, 'nonzero_exit');
  assert.equal(job.process.exitCode, null); assert.equal(job.exitCode, null);
  assert.equal(job.process.signal, 'SIGKILL');
  assert.match(job.process.stderrTail, /stream cut short/);
  const stored = readJob(workspaceStore(options.cwd, options.stateDir), job.id);
  assert.equal(stored.process.signal, 'SIGKILL'); assert.equal(stored.report.process.exitCode, null);
});
test('an error envelope with a nonzero exit is a failed run with its exit code', async t => {
  const job = await delegate(failing(t, 'ERROR_ENVELOPE'));
  assert.equal(job.status, 'failed'); assert.equal(job.failure.kind, 'nonzero_exit');
  assert.equal(job.process.exitCode, 1); assert.match(job.process.stderrTail, /overloaded/);
});
test('spawn failure after compatibility checks is recorded as kind spawn', async t => {
  const options = failing(t, 'Inspect');
  const script = path.join(path.dirname(options.cwd), 'vanishing.mjs');
  fs.copyFileSync(failures, script); fs.chmodSync(script, 0o755);
  // Strip the execute bit after the job is queued so only the real launch fails.
  const job = await delegate({ ...options, binary: script, onJob() { fs.chmodSync(script, 0o644); } });
  assert.equal(job.status, 'failed'); assert.equal(job.failure.kind, 'spawn');
  assert.match(job.process.spawnError, /EACCES/); assert.equal(job.process.exitCode, null);
  assert.match(job.failure.message, /Could not start Claude/);
});
test('timeouts and permission denials get their own failure kinds', async t => {
  const timeout = await delegate({ ...context(t), prompt: 'HANG', timeoutMs: 300 });
  assert.equal(timeout.status, 'timed_out'); assert.equal(timeout.failure.kind, 'timeout');
  const denied = await delegate({ ...context(t), prompt: 'DENIED' });
  assert.equal(denied.status, 'incomplete'); assert.equal(denied.failure.kind, 'permission_denied');
  const ok = await delegate(context(t));
  assert.equal(ok.status, 'completed'); assert.equal(ok.failure ?? null, null);
});

import { parseUsage, usageLine } from '../src/diagnostics.mjs';
test('usage is parsed from the result envelope: multiple models, aggregate and allowlist', async t => {
  const options = failing(t, 'USAGE');
  const job = await delegate(options);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.usage, {
    inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheCreationTokens: 100, costUsd: 0.0123,
    byModel: {
      'claude-opus-5-5': { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 4000, cacheCreationTokens: 100, costUsd: 0.01 },
      'claude-haiku-5-5': { inputTokens: 200, outputTokens: 40, cacheReadTokens: 1000, cacheCreationTokens: 0, costUsd: 0.0023 },
    },
  });
  const stored = JSON.stringify(readJob(workspaceStore(options.cwd, options.stateDir), job.id));
  assert.ok(!stored.includes('must-not-be-stored') && !stored.includes('secret-tier') && !stored.includes('contextWindow'));
  assert.match(usageLine(job.usage), /tokens: 1200 in, 340 out, 5000 cache read, 100 cache write; reported cost: \$0\.0123 \(2 models\)/);
});
test('missing and invalid usage values become null; absent usage stays null', () => {
  assert.equal(parseUsage({ type: 'result' }), null);
  assert.equal(parseUsage(null), null);
  const partial = parseUsage({ usage: { input_tokens: 10 }, modelUsage: { m: { inputTokens: 10, outputTokens: 'lots', cacheReadInputTokens: -4, cacheCreationInputTokens: 1.5, costUSD: NaN } } });
  assert.deepEqual(partial, { inputTokens: 10, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
    byModel: { m: { inputTokens: 10, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null } } });
  const bad = parseUsage({ usage: { input_tokens: '5', output_tokens: Infinity, cache_read_input_tokens: null }, total_cost_usd: -1, modelUsage: [] });
  assert.deepEqual(bad, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, byModel: {} });
  assert.equal(usageLine(bad), undefined);
});
test('without a reported total, the aggregate sums per-model values that are known', () => {
  const usage = parseUsage({ modelUsage: { a: { inputTokens: 5, costUSD: 0.5 }, b: { inputTokens: 7, costUSD: 'x' }, '../bad name': { inputTokens: 99 } } });
  assert.equal(usage.inputTokens, 12); assert.equal(usage.outputTokens, null); assert.equal(usage.costUsd, 0.5);
  assert.deepEqual(Object.keys(usage.byModel), ['a', 'b']);
});
