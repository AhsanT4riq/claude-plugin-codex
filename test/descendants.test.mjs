import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delegate, workspaceStore } from '../src/runtime.mjs';
import { parseProcessTable, descendantsOf, processTable, recordDescendants, trackedSurvivors, groupMayBeRunning, readLock, statusView } from '../src/state.mjs';

const fixture = fileURLToPath(new URL('./fake-claude.fixture.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('Timed out waiting for process state.');
}
function detachedSleeper(t) {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  return child;
}

test('process table rows parse with real lstart identities and walk descendants', () => {
  const rows = parseProcessTable([
    '    1     0     1 Sat Oct 10 11:47:24 2026    ',
    '  500     1   500 Sun Nov  1 04:54:02 2026',
    '  501   500   501 Sun Nov  1 04:54:03 2026',
    '  502   501   501 Sun Nov  1 04:54:03 2026',
    'garbage line',
  ].join('\n'));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], { pid: 500, ppid: 1, pgid: 500, startTime: 'Sun Nov 1 04:54:02 2026' });
  assert.deepEqual(descendantsOf(500, rows).map(r => r.pid), [501, 502]);
  assert.deepEqual(descendantsOf(502, rows), []);
});

test('detached groups are recorded apart from the CLI group and a reused group number is ignored', t => {
  const rows = [
    { pid: 10, ppid: 1, pgid: 10, startTime: 'x' },
    { pid: 11, ppid: 10, pgid: 10, startTime: 'x' },
    { pid: 12, ppid: 10, pgid: 12, startTime: 'x' },
  ];
  const job = { childPid: 10, processGroup: { pgid: 10 } };
  assert.equal(recordDescendants(job, rows), true);
  assert.deepEqual(job.detachedGroups, [12]);
  assert.equal(recordDescendants(job, rows), false, 'An unchanged tree needs no save.');

  const sleeper = detachedSleeper(t);
  const live = { detachedGroups: [sleeper.pid], startedAt: new Date(Date.now() - 5000).toISOString() };
  assert.ok(processTable(), 'These checks require a real process table.');
  assert.deepEqual(trackedSurvivors(live).map(r => r.pid), [sleeper.pid]);
  assert.equal(groupMayBeRunning(live), true, 'A live detached survivor keeps the workspace leased.');
  const reused = { ...live, startedAt: new Date(Date.now() + 60_000).toISOString() };
  assert.deepEqual(trackedSurvivors(reused), [], 'Members started before the job are not its survivors.');
  assert.equal(trackedSurvivors(live, null), null, 'An unavailable process table is unknown, not empty.');
  assert.equal(groupMayBeRunning({ ...live, processGroup: { pgid: 999_999_9 } }, null), true);
});

test('a process Claude backgrounds in another group is stopped at job end and reported', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-detached-'));
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const job = await delegate({ cwd, stateDir, binary: fixture, kind: 'rescue', prompt: 'DETACHED_CHILD', timeoutMs: 30_000 });
  const pidFile = path.join(root, `.fake-claude-${job.childPid}.detached`);
  const sleeper = Number(fs.readFileSync(pidFile, 'utf8').trim());
  t.after(() => { try { process.kill(sleeper, 'SIGKILL'); } catch {} });
  assert.equal(job.status, 'completed');
  assert.ok(job.detachedGroups?.length, 'The shell group must be sampled while the CLI runs.');
  assert.equal(job.detachedProcesses.length, 1);
  assert.equal(job.detachedProcesses[0].pid, sleeper);
  assert.equal(job.detachedProcesses[0].stopped, true);
  await until(() => !alive(sleeper));
  assert.match(job.evidence.warnings.join('\n'), /background process\(es\) Claude started were still running at job end and were stopped/);
  assert.equal(job.childMayBeRunning, false);
  assert.equal(readLock(workspaceStore(cwd, stateDir)), null);
});

test('status summaries use the structured summary rather than the raw contract JSON', () => {
  const raw = JSON.stringify({ summary: 'survived', completion: 'completed' });
  assert.equal(statusView({ id: 'x', result: raw, structuredOutput: { summary: 'survived' } }).summary, 'survived');
  assert.equal(statusView({ id: 'x', result: 'plain text\nmore' }).summary, 'plain text');
  assert.equal(statusView({ id: 'x', result: raw, review: { summary: 'Review summary' } }).summary, 'Review summary');
});
