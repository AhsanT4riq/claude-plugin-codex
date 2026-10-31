import { waitForReady, executionFromReadiness, backgroundExecutionFromReadiness } from './fake-claude.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { launchBackground, statusJob, resultJob, cancelJob, delegate, workspaceStore } from '../src/runtime.mjs';
import { readJob, active, artifact, atomicJson, readLock, groupMayBeRunning, groupIdentityMatches, acquireLock, saveJob, bootIdentity, processGroupIdentity, leaderStartTime, signalProcessGroup } from '../src/state.mjs';
const fixture = fileURLToPath(new URL('./fake-claude.fixture.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../bin/claude-companion.mjs', import.meta.url));
function context(t, synchronize = true) {
  backgroundExecutionFromReadiness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-background-'));
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state'); let current;
  if (synchronize) executionFromReadiness(t, cwd, () => current && readJob(current.store, current.id).childPid);
  return { cwd, stateDir, binary: fixture, kind: 'rescue', prompt: 'SLOW', timeoutMs: 3000,
    onJob(job) { current = { id: job.id, store: workspaceStore(cwd, stateDir) }; } };
}
async function until(fn, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('Timed out waiting for fixture state.');
}
const finished = async (store, id) => {
  const started = await until(() => { const job = readJob(store, id); return (job.childPid || !active(job)) && job; }, 15_000);
  if (active(started)) await waitForReady(store.cwd, () => started.childPid);
  return until(() => { const job = resultJob(store, id); return !active(job) && job; });
};
const ready = (options, store, id) => waitForReady(options.cwd, () => readJob(store, id).childPid);

test('background launcher exits; worker publishes early session/progress and final result', async t => {
  const options = context(t);
  const p = spawnSync(process.execPath, [cli, 'rescue', '--background', '--cwd', options.cwd, '--state-dir', options.stateDir, '--prompt', 'WAIT'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_BINARY: fixture }, timeout: 15_000 });
  assert.equal(p.status, 0, p.stderr);
  const ack = JSON.parse(p.stdout); assert.equal(ack.status, 'queued');
  const store = workspaceStore(options.cwd, options.stateDir);
  const fixtureReady = await ready(options, store, ack.id);
  const running = await until(async () => { const s = await statusJob(store, ack.id); return s.sessionId && active(s) && s.events.some(event => event.type === 'tool_started') && s; });
  assert.ok(running.events.some(e => e.type === 'tool_started'));
  fixtureReady.release();
  const next = await statusJob(store, ack.id, { after: running.cursor, wait: true, timeoutMs: 1500 });
  assert.ok(next.events.every(e => e.sequence > running.cursor));
  const final = await finished(store, ack.id); assert.equal(final.status, 'completed');
  assert.ok(!JSON.stringify(final).includes('SECRET_THINKING'));
  assert.ok(!JSON.stringify(final).includes('SECRET_UNKNOWN'));
  assert.equal(readLock(store), null);
  assert.equal(fs.existsSync(artifact(store, ack.id, '.request.json')), false);
});
test('status --job selects one job and rejects an unknown UUID', async t => {
  const options = context(t); const job = await delegate(options);
  const run = id => spawnSync(process.execPath, [cli, 'status', '--cwd', options.cwd, '--state-dir', options.stateDir, '--job', id], { encoding: 'utf8' });
  const found = run(job.id); assert.equal(found.status, 0); assert.equal(JSON.parse(found.stdout).id, job.id);
  const missing = run('11111111-1111-4111-8111-111111111111'); assert.equal(missing.status, 1); assert.match(missing.stderr, /ENOENT/);
});
test('background cancellation preserves early session and frees the lease', async t => {
  const options = { ...context(t), prompt: 'HANG' };
  const ack = await launchBackground(options); const store = workspaceStore(options.cwd, options.stateDir);
  await ready(options, store, ack.id);
  await until(() => readJob(store, ack.id).sessionId);
  assert.equal(cancelJob(store, ack.id).status, 'cancellation_requested');
  const final = await finished(store, ack.id);
  assert.equal(final.status, 'cancelled'); assert.ok(final.sessionId); assert.equal(readLock(store), null);
  assert.equal((await delegate({ ...options, prompt: 'SLOW' })).status, 'completed');
});
test('timeout execution deadline is exercised from known fixture readiness', async t => {
  const options = { ...context(t, false), prompt: 'HANG', timeoutMs: 800 };
  const store = workspaceStore(options.cwd, options.stateDir);
  // Freeze only the bridge's timers: the real child and readiness polling keep running.
  // Startup contention cannot consume the execution deadline being tested.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let id;
  const work = delegate({ ...options, onJob(job) { id = job.id; } });
  await waitForReady(options.cwd, () => { const job = readJob(store, id); return job.sessionId && job.childPid; });
  const running = readJob(store, id);
  assert.ok(active(running));
  t.mock.timers.tick(800);
  t.mock.timers.tick(2000); // Complete the unchanged termination escalation.
  const final = await work;
  assert.equal(final.status, 'timed_out'); assert.ok(final.sessionId);
});
test('bounded status wait does not pretend a ready fixture has completed', async t => {
  const options = { ...context(t), prompt: 'HANG' };
  const ack = await launchBackground(options), store = workspaceStore(options.cwd, options.stateDir);
  await ready(options, store, ack.id);
  await until(() => readJob(store, ack.id).events?.some(event => event.type === 'tool_started'));
  const running = readJob(store, ack.id);
  const snapshot = await statusJob(store, ack.id, { after: running.cursor, wait: true, timeoutMs: 30 });
  assert.equal(snapshot.waitTimedOut, true); assert.ok(active(snapshot));
  cancelJob(store, ack.id);
  assert.equal((await finished(store, ack.id)).status, 'cancelled');
});
test('competing background launches cannot share a workspace', async t => {
  const options = { ...context(t), prompt: 'WAIT' }; const ack = await launchBackground(options);
  const store = workspaceStore(options.cwd, options.stateDir);
  const marker = await ready(options, store, ack.id);
  await assert.rejects(launchBackground(options), /workspace lock/);
  marker.release();
  assert.equal((await finished(store, ack.id)).status, 'completed');
});
test('fragmented UTF-8 stream and unknown event types preserve final output', async t => {
  const job = await delegate({ ...context(t), prompt: 'FRAGMENT' });
  assert.equal(job.status, 'completed'); assert.equal(JSON.parse(job.result).unicode, 'café 漢字');
});
test('oversized event, malformed events and missing executables fail terminally', async t => {
  const options = context(t);
  for (const prompt of ['BAD_JSON', 'NULL_JSON', 'OUTPUT_LIMIT']) {
    const ack = await launchBackground({ ...options, prompt });
    const final = await finished(workspaceStore(options.cwd, options.stateDir), ack.id);
    assert.ok(['failed', 'output_limit'].includes(final.status), final.status);
  }
  // A missing executable is now rejected by the compatibility gate before any worker or lease exists (B01).
  await assert.rejects(launchBackground({ ...options, binary: '/no/such/claude' }), e => e.failure?.kind === 'missing_cli');
});
test('a dead worker is interrupted without replaying its persisted request', async t => {
  const options = context(t); const ack = await launchBackground({ ...options, prompt: 'HANG' });
  const store = workspaceStore(options.cwd, options.stateDir);
  await ready(options, store, ack.id);
  const live = await until(() => { const j = readJob(store, ack.id); return j.childPid && j.sessionId && j; });
  // Stop only processes created by this fixture; simulate an uncatchable worker crash.
  process.kill(live.workerPid, 'SIGKILL'); process.kill(-live.childPid, 'SIGKILL');
  await until(() => { const j = resultJob(store, ack.id); return j.status === 'interrupted' && !j.childMayBeRunning; });
  assert.equal(readLock(store), null);
  assert.equal((await delegate({ ...options, prompt: 'SLOW' })).status, 'completed');
});
test('cursor window declares truncation and owner-filtered listing does not mix chats', async t => {
  const options = context(t); const job = await delegate({ ...options, ownerId: 'chat-a' });
  const store = workspaceStore(options.cwd, options.stateDir); const stored = readJob(store, job.id);
  stored.cursor = 999; stored.events = [{ sequence: 999, message: 'bounded event', at: new Date().toISOString() }];
  atomicJson(artifact(store, job.id), stored);
  assert.equal((await statusJob(store, job.id, { after: 0 })).eventsTruncated, true);
  const p = spawnSync(process.execPath, [cli, 'status', '--cwd', options.cwd, '--state-dir', options.stateDir, '--owner-id', 'chat-b'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(p.stdout), []);
});
test('worker crash with a live orphan keeps its lease until the orphan stops', async t => {
  const options = context(t); const ack = await launchBackground({ ...options, prompt: 'HANG' });
  const store = workspaceStore(options.cwd, options.stateDir);
  await ready(options, store, ack.id);
  const live = await until(() => { const j = readJob(store, ack.id); return j.childPid && j.sessionId && j; });
  t.after(() => { try { process.kill(-live.childPid, 'SIGKILL'); } catch {} });
  process.kill(live.workerPid, 'SIGKILL');
  await until(() => resultJob(store, ack.id).status === 'interrupted');
  assert.equal(resultJob(store, ack.id).childMayBeRunning, true);
  await assert.rejects(launchBackground(options), /workspace lock/);
  process.kill(-live.childPid, 'SIGKILL');
  await until(() => !resultJob(store, ack.id).childMayBeRunning);
  assert.equal((await delegate(options)).status, 'completed');
});
test('CLI rejects options irrelevant to a command instead of ignoring them', t => {
  const options = context(t);
  for (const args of [['status', '--prompt', 'ignored'], ['rescue', '--job', 'ignored'], ['setup', '--write']]) {
    const p = spawnSync(process.execPath, [cli, ...args, '--cwd', options.cwd], { encoding: 'utf8' });
    assert.equal(p.status, 1); assert.match(p.stderr, /not supported/);
  }
});
test('cancellation before Claude startup never launches the child and returns final state', async t => {
  const options = context(t); const store = workspaceStore(options.cwd, options.stateDir);
  const job = await delegate({ ...options, onJob(current) { cancelJob(store, current.id); } });
  assert.equal(job.status, 'cancelled'); assert.equal(job.phase, 'cancelled');
  assert.equal(job.childPid, undefined); assert.equal(job.events.at(-1).type, 'finished');
  assert.equal(readLock(store), null);
});

test('leader crash leaves a same-group descendant holding the workspace lease', async t => {
  const options = { ...context(t), prompt: 'DESCENDANT_HANG', timeoutMs: 60_000 };
  const ack = await launchBackground(options), store = workspaceStore(options.cwd, options.stateDir);
  const marker = await ready(options, store, ack.id);
  const live = readJob(store, ack.id);
  assert.ok(marker.descendantPid);
  assert.equal(live.processGroup.pgid, live.childPid);
  assert.equal(live.processGroup.leaderPid, live.childPid);
  assert.ok(live.processGroup.leaderStartTime, 'The leader must have a real ps identity.');
  assert.equal(live.processGroup.leaderStartTime, leaderStartTime(live.childPid));
  assert.equal(live.processGroup.bootId, bootIdentity());
  assert.ok(live.processGroup.bootId);
  assert.equal(Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(marker.descendantPid)], { encoding: 'utf8' }).stdout.trim()), live.processGroup.pgid);
  t.after(() => { try { process.kill(-live.childPid, 'SIGKILL'); } catch {} });
  process.kill(live.childPid, 'SIGKILL'); // Leave the bridge worker alive to finalize normally.
  const orphan = await until(() => { const job = resultJob(store, ack.id); return !active(job) && job; });
  assert.equal(orphan.childMayBeRunning, true);
  assert.equal(orphan.status, 'failed');
  assert.ok(readLock(store));
  await assert.rejects(launchBackground(options), /workspace lock/);
  process.kill(marker.descendantPid, 'SIGKILL');
  await until(() => !resultJob(store, ack.id).childMayBeRunning);
  assert.equal(readLock(store), null);
});
// These checks require real OS probes. Missing access is a failure here, with
// unavailable identities exercised separately below rather than silently substituted.
async function liveGroup(t) {
  const child = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const identity = processGroupIdentity(child.pid);
  assert.ok(identity.leaderStartTime, 'ps must return the real leader start time.');
  assert.match(identity.bootId || '', /^[0-9a-f-]{36}$/i, 'The real boot probe must succeed.');
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(ps.status, 0); assert.equal(identity.leaderStartTime, ps.stdout.trim());
  assert.equal(groupIdentityMatches(identity), true);
  assert.equal(groupMayBeRunning({ processGroup: identity }), true);
  return identity;
}
function recordOrphan(store, cwd, group) {
  const job = { version: 2, id: '11111111-1111-4111-8111-111111111111', lockToken: 'test', cwd,
    status: 'running', createdAt: new Date(0).toISOString(), ownerPid: 99999999, bootId: group.bootId,
    processGroup: group };
  acquireLock(store, job); saveJob(store, job);
  return job;
}
function observeSignals(t) {
  const kill = process.kill.bind(process), signals = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal !== 0) signals.push({ pid, signal });
    return kill(pid, signal);
  });
  return signals;
}
test('real probes allow matching groups and reject reused-PID start times without releasing their lease', async t => {
  const options = context(t), store = workspaceStore(options.cwd, options.stateDir);
  const identity = await liveGroup(t), signals = observeSignals(t);
  assert.equal(signalProcessGroup(identity, 'SIGCONT'), true);
  assert.deepEqual(signals, [{ pid: -identity.pgid, signal: 'SIGCONT' }]);
  signals.length = 0;
  // A different recorded start time is exactly the persisted identity mismatch
  // produced by PID reuse; the current leader is a real, unrelated live process.
  const oldStart = leaderStartTime(1);
  assert.ok(oldStart); assert.notEqual(oldStart, identity.leaderStartTime);
  const reused = { ...identity, leaderStartTime: oldStart };
  assert.equal(groupIdentityMatches(reused), false);
  assert.equal(signalProcessGroup(reused, 'SIGTERM'), false);
  const job = recordOrphan(store, options.cwd, reused);
  assert.equal(resultJob(store, job.id).childMayBeRunning, true);
  assert.throws(() => acquireLock(store, { id: 'other', lockToken: 'other' }), /workspace lock/);
  assert.ok(readLock(store)); assert.deepEqual(signals, []);
  assert.equal(groupMayBeRunning(job), true);
});
test('a changed recorded boot id releases the obsolete lease without signalling the current live group', async t => {
  const options = context(t), store = workspaceStore(options.cwd, options.stateDir);
  const identity = await liveGroup(t), signals = observeSignals(t);
  const oldBoot = { ...identity, bootId: identity.bootId === '00000000-0000-0000-0000-000000000000'
    ? '11111111-1111-1111-1111-111111111111' : '00000000-0000-0000-0000-000000000000' };
  assert.equal(signalProcessGroup(oldBoot, 'SIGTERM'), false);
  const job = recordOrphan(store, options.cwd, oldBoot);
  const final = resultJob(store, job.id);
  assert.equal(final.status, 'interrupted'); assert.equal(final.childMayBeRunning, false);
  assert.equal(readLock(store), null); assert.deepEqual(signals, []);
  assert.equal(groupMayBeRunning({ processGroup: identity }), true);
});
test('unknown recorded boot identity keeps a real live group leased and unsignalled', async t => {
  const options = context(t), store = workspaceStore(options.cwd, options.stateDir);
  const identity = await liveGroup(t), signals = observeSignals(t);
  const unknown = { ...identity, bootId: null };
  assert.equal(signalProcessGroup(unknown, 'SIGTERM'), false);
  const job = recordOrphan(store, options.cwd, unknown);
  assert.equal(resultJob(store, job.id).childMayBeRunning, true);
  assert.throws(() => acquireLock(store, { id: 'other', lockToken: 'other' }), /workspace lock/);
  assert.ok(readLock(store)); assert.deepEqual(signals, []);
});
test('a denied ps probe keeps a real live group leased and unsignalled', async t => {
  const options = context(t), store = workspaceStore(options.cwd, options.stateDir);
  const identity = await liveGroup(t), signals = observeSignals(t);
  const bin = path.join(options.cwd, '..', 'denied-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\necho "ps: permission denied" >&2\nexit 1\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  assert.equal(leaderStartTime(identity.leaderPid), null);
  assert.equal(signalProcessGroup(identity, 'SIGTERM'), false);
  const job = recordOrphan(store, options.cwd, identity);
  assert.equal(resultJob(store, job.id).childMayBeRunning, true);
  assert.throws(() => acquireLock(store, { id: 'other', lockToken: 'other' }), /workspace lock/);
  assert.ok(readLock(store)); assert.deepEqual(signals, []);
});
test('a denied boot probe rejects signalling while ps and group liveness still use real OS data', async t => {
  const identity = await liveGroup(t);
  // Isolate the cached boot probe in a fresh process and deny only boot-identity reads.
  const code = `
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const probe = cp.spawnSync, read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      if (file === '/proc/sys/kernel/random/boot_id') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return read(file, ...args);
    };
    cp.spawnSync = (binary, ...args) => binary === '/usr/sbin/sysctl'
      ? { status: 1, stdout: '', stderr: 'permission denied' } : probe(binary, ...args);
    syncBuiltinESMExports();
    const state = await import(process.argv[1]), group = JSON.parse(process.argv[2]);
    const kill = process.kill.bind(process), signals = [];
    process.kill = (pid, signal) => { if (signal !== 0) signals.push({ pid, signal }); return kill(pid, signal); };
    console.log(JSON.stringify({ boot: state.bootIdentity(), start: state.leaderStartTime(group.leaderPid),
      alive: state.groupMayBeRunning({ processGroup: group }),
      signalled: state.signalProcessGroup(group, 'SIGTERM'), signals }));
  `;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code,
    new URL('../src/state.mjs', import.meta.url).href, JSON.stringify(identity)], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { boot: null, start: identity.leaderStartTime, alive: true, signalled: false, signals: [] });
  assert.equal(groupMayBeRunning({ processGroup: identity }), true);
});
test('foreground cancellation actually signals a group whose real identity matches', async t => {
  const options = { ...context(t), prompt: 'HANG' }, store = workspaceStore(options.cwd, options.stateDir);
  const signals = observeSignals(t); let id;
  const work = delegate({ ...options, onJob(job) { options.onJob(job); id = job.id; } });
  await waitForReady(options.cwd, () => { const job = readJob(store, id); return job.sessionId && job.childPid; });
  const live = readJob(store, id);
  assert.equal(groupIdentityMatches(live.processGroup), true);
  cancelJob(store, id);
  assert.equal((await work).status, 'cancelled');
  assert.ok(signals.some(entry => entry.pid === -live.childPid && entry.signal === 'SIGINT'));
  assert.equal(groupMayBeRunning(live), false); assert.equal(readLock(store), null);
});
