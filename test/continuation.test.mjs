import { waitForReady, executionFromReadiness, backgroundExecutionFromReadiness } from './fake-claude.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { delegate, launchBackground, resultJob, resumeCandidates, workspaceStore } from '../src/runtime.mjs';
import { active, saveJob, readJob, readLock, artifact } from '../src/state.mjs';
const fixture = fileURLToPath(new URL('./fake-claude.fixture.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../bin/claude-companion.mjs', import.meta.url));
function context(t) {
  backgroundExecutionFromReadiness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-continuation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  const stateDir = path.join(root, 'state'); let current;
  executionFromReadiness(t, cwd, () => current && readJob(current.store, current.id).childPid);
  return { cwd, stateDir, binary: fixture, kind: 'rescue', ownerId: 'chat-a', prompt: 'Plan a change', timeoutMs: 3000,
    onJob(job) { current = { id: job.id, store: workspaceStore(cwd, stateDir) }; } };
}
async function finish(store, id) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const job = resultJob(store, id);
    if (!active(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Fixture worker did not finish.');
}
const arg = (job, name) => { const args = JSON.parse(job.result).args; return args[args.indexOf(name) + 1]; };

test('revision inherits model, effort, owner and lineage; explicit overrides persist', async t => {
  const options = context(t);
  const plan = await delegate({ ...options, model: 'chosen-model', effort: 'high' });
  const revision = await delegate({ ...options, ownerId: undefined, resume: plan.id, prompt: 'Revise the plan' });
  assert.equal(revision.ownerId, options.ownerId);
  assert.equal(revision.parentJobId, plan.id); assert.equal(revision.rootJobId, plan.id);
  assert.equal(arg(revision, '--model'), 'chosen-model'); assert.equal(arg(revision, '--effort'), 'high');
  const override = await delegate({ ...options, resume: revision.id, model: 'replacement-model', effort: 'low' });
  const next = await delegate({ ...options, resume: override.id });
  assert.equal(arg(next, '--model'), 'replacement-model'); assert.equal(arg(next, '--effort'), 'low');
  assert.equal(next.sessionId, plan.sessionId); assert.equal(next.rootJobId, plan.id);
});

test('resumed rescue changes tools only through explicit flags on the new turn', async t => {
  const options = context(t); const plan = await delegate(options);
  const implementation = await delegate({ ...options, resume: plan.id, write: true, allowBash: true, prompt: 'WRITE_FILE' });
  assert.equal(implementation.sessionId, plan.sessionId);
  assert.equal(arg(implementation, '--tools'), 'Read,Glob,Grep,Edit,Write,Bash');
  assert.deepEqual(implementation.permissionChange, { from: { write: false, allowBash: false }, to: { write: true, allowBash: true } });
  fs.unlinkSync(path.join(options.cwd, 'delegated.txt'));
  const readonly = await delegate({ ...options, resume: implementation.id, prompt: 'WRITE_FILE' });
  assert.equal(arg(readonly, '--tools'), 'Read,Glob,Grep');
  assert.equal(fs.existsSync(path.join(options.cwd, 'delegated.txt')), false);
  await assert.rejects(delegate({ ...options, resume: readonly.id, allowBash: true }), /requires --write/);
});

test('reviews cannot acquire write or shell capability, or resume as rescue', async t => {
  const options = context(t);
  for (const kind of ['review', 'adversarial-review']) {
    const review = await delegate({ ...options, kind });
    await assert.rejects(delegate({ ...options, kind, resume: review.id, write: true }), /do not allow/);
    await assert.rejects(delegate({ ...options, kind, resume: review.id, allowBash: true }), /requires --write/);
    await assert.rejects(delegate({ ...options, resume: review.id, write: true }), /same command/);
    const continued = await delegate({ ...options, kind, resume: review.id });
    assert.equal(arg(continued, '--tools'), 'Read,Glob,Grep');
  }
});

test('owner-scoped candidates expose session heads and never infer a chat', async t => {
  const options = context(t); const store = workspaceStore(options.cwd, options.stateDir);
  const a = await delegate(options);
  const b = await delegate({ ...options, ownerId: 'chat-b' });
  const unowned = await delegate({ ...options, ownerId: undefined });
  const revision = await delegate({ ...options, resume: a.id });
  assert.deepEqual(resumeCandidates(store).candidates, []);
  assert.equal(resumeCandidates(store).requiresExplicitJob, true);
  assert.deepEqual(resumeCandidates(store, 'chat-a').candidates.map(j => j.id), [revision.id]);
  assert.deepEqual(resumeCandidates(store, 'chat-b').candidates.map(j => j.id), [b.id]);
  assert.deepEqual(resumeCandidates(store, 'chat-c').candidates, []);
  await assert.rejects(delegate({ ...options, resume: b.id }), /another owner/);
  // Explicit UUID selection remains possible when the calling chat cannot supply identity.
  assert.equal((await delegate({ ...options, ownerId: undefined, resume: unowned.id })).status, 'completed');
});

test('running session heads suppress earlier turns; background continuation retains choices', async t => {
  const options = context(t); const store = workspaceStore(options.cwd, options.stateDir);
  const plan = await delegate({ ...options, effort: 'medium', model: 'chosen-model' });
  const ack = await launchBackground({ ...options, resume: plan.id, prompt: 'WAIT', write: true });
  const ready = await waitForReady(options.cwd, () => readJob(store, ack.id).childPid);
  assert.deepEqual(resumeCandidates(store, 'chat-a').candidates, []);
  await assert.rejects(delegate({ ...options, resume: ack.id }), /still running/);
  ready.release();
  const final = await finish(store, ack.id);
  assert.equal(final.status, 'completed'); assert.equal(final.sessionId, plan.sessionId);
  assert.equal(arg(final, '--effort'), 'medium'); assert.equal(arg(final, '--model'), 'chosen-model');
  assert.deepEqual(resumeCandidates(store, 'chat-a').candidates.map(j => j.id), [final.id]);
});

test('missing sessions and live orphans cannot become resumable candidates', async t => {
  const options = context(t); const store = workspaceStore(options.cwd, options.stateDir);
  // Passes the compatibility probe, then dies before announcing any session.
  const silent = path.join(path.dirname(options.cwd), 'silent-claude');
  fs.writeFileSync(silent, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.1.292; exit 0; fi\nexit 3\n', { mode: 0o755 });
  const failed = await delegate({ ...options, binary: silent });
  assert.equal(failed.status, 'failed'); assert.equal(failed.process.exitCode, 3);
  assert.deepEqual(resumeCandidates(store, 'chat-a').candidates, []);
  await assert.rejects(delegate({ ...options, resume: failed.id }), /no resumable/);
  const completed = await delegate(options);
  saveJob(store, { ...completed, status: 'interrupted', childMayBeRunning: true, processGroup: null, childPid: process.pid });
  assert.deepEqual(resumeCandidates(store, 'chat-a').candidates, []);
  await assert.rejects(delegate({ ...options, resume: completed.id }), /orphan cleanup/);
});

test('CLI discovery requires exact selection and rejects ambiguous option combinations', async t => {
  const options = context(t); const job = await delegate(options);
  const run = args => spawnSync(process.execPath, [cli, 'status', '--cwd', options.cwd, '--state-dir', options.stateDir, '--resume-candidates', ...args], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run([]).stdout).candidates, []);
  const found = run(['--owner-id', 'chat-a']); assert.equal(found.status, 0);
  assert.equal(JSON.parse(found.stdout).candidates[0].id, job.id);
  for (const args of [['--job', job.id], ['--wait'], ['--after', '0'], ['--timeout', '2']]) {
    const invalid = run(args); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /cannot be combined/);
  }
});

test('A to B to C has truthful ancestry and stale A is rejected with the current head', async t => {
  const options = context(t), store = workspaceStore(options.cwd, options.stateDir);
  const a = await delegate(options);
  const b = await delegate({ ...options, resume: a.id });
  const c = await delegate({ ...options, resume: b.id });
  assert.equal(b.parentJobId, a.id); assert.equal(c.parentJobId, b.id);
  assert.equal(c.rootJobId, a.id); assert.equal(c.sessionId, a.sessionId);
  let rejected;
  await assert.rejects(delegate({ ...options, resume: a.id }), error => {
    rejected = error;
    return error.failure?.kind === 'stale_parent' && error.message.includes(c.id);
  });
  const stored = readJob(store, rejected.jobId);
  assert.equal(stored.failure.kind, 'stale_parent'); assert.equal(stored.status, 'failed');
  assert.equal(fs.existsSync(artifact(store, stored.id, '.request.json')), false);
  assert.equal(readLock(store), null);
  assert.deepEqual(resumeCandidates(store, options.ownerId).candidates.map(job => job.id), [c.id]);
  assert.equal((await delegate({ ...options, resume: c.id })).status, 'completed');
});
test('concurrent resumes of the same session head accept exactly one successor', async t => {
  const options = context(t), head = await delegate(options);
  const resume = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'rescue', '--cwd', options.cwd, '--state-dir', options.stateDir,
      '--resume', head.id, '--owner-id', options.ownerId, '--prompt', 'Inspect'],
    { env: { ...process.env, CLAUDE_CODE_BINARY: fixture }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  const outcomes = await Promise.all([resume(), resume()]);
  const accepted = outcomes.filter(outcome => outcome.code === 0);
  const rejected = outcomes.filter(outcome => outcome.code !== 0);
  assert.equal(accepted.length, 1, JSON.stringify(outcomes)); assert.equal(rejected.length, 1);
  const successor = JSON.parse(accepted[0].stdout);
  assert.equal(successor.status, 'completed');
  assert.equal(successor.parentJobId, head.id);
  assert.match(rejected[0].stderr, /workspace lock|stale job/);
  await assert.rejects(delegate({ ...options, resume: head.id }), error => error.failure?.kind === 'stale_parent');
});
