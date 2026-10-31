#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Test-only handshake: startup and execution have separate observation deadlines.
const startupDelay = globalThis.setTimeout;
const readyPath = (cwd, pid) => path.resolve(cwd, '..', `.fake-claude-${pid}.ready`);
export async function waitForReady(cwd, getPid, timeoutMs = 15_000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    const pid = getPid();
    if (pid && fs.existsSync(readyPath(cwd, pid))) {
      const marker = JSON.parse(fs.readFileSync(readyPath(cwd, pid), 'utf8'));
      return { ...marker, released: () => fs.existsSync(`${readyPath(cwd, pid)}.release`), release() { fs.writeFileSync(`${readyPath(cwd, pid)}.release`, ''); } };
    }
    await new Promise(resolve => startupDelay(resolve, 10));
  }
  throw new Error('Fake Claude did not become ready.');
}
// Keep short execution budgets meaningful without charging real fixture startup to them.
// This is a test-only clock adapter; production runProcess still times from spawn.
function executionClock(cwd, getPid, timeoutMs) {
  const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
  const deferred = new Set();
  return {
    setTimeout(callback, delay, ...args) {
      if (delay !== timeoutMs) return setTimer(callback, delay, ...args);
      const handle = { timer: null, cancelled: false, controller: new AbortController() };
      deferred.add(handle);
      waitForReady(cwd, getPid, 15_000, handle.controller.signal).then(async marker => {
        // A WAIT fixture is ready to execute only after the test opens its gate.
        const deadline = Date.now() + 15_000;
        while (!handle.cancelled && marker?.waitingForRelease && !marker.released() && Date.now() < deadline) {
          await new Promise(resolve => startupDelay(resolve, 10));
        }
        if (!handle.cancelled) handle.timer = setTimer(callback, delay, ...args);
      }, () => {
        // A fixture that never becomes ready must fail rather than wait forever.
        if (!handle.cancelled) handle.timer = setTimer(callback, 0, ...args);
      });
      return handle;
    },
    clearTimeout(handle) {
      if (!deferred.has(handle)) return clearTimer(handle);
      handle.cancelled = true; handle.controller.abort();
      clearTimer(handle.timer); deferred.delete(handle);
    },
    cleanup() {
      for (const handle of deferred) { handle.cancelled = true; handle.controller.abort(); clearTimer(handle.timer); }
    },
  };
}
export function executionFromReadiness(t, cwd, getPid, timeoutMs = 3000) {
  const clock = executionClock(cwd, getPid, timeoutMs);
  t.mock.method(globalThis, 'setTimeout', clock.setTimeout);
  t.mock.method(globalThis, 'clearTimeout', clock.clearTimeout);
  t.after(clock.cleanup);
}
export function backgroundExecutionFromReadiness(t, timeoutMs = 3000) {
  const previous = { options: process.env.NODE_OPTIONS, clock: process.env.CLAUDE_FIXTURE_CLOCK_MS };
  process.env.NODE_OPTIONS = `${previous.options || ''} --import=${JSON.stringify(import.meta.url)}`;
  process.env.CLAUDE_FIXTURE_CLOCK_MS = String(timeoutMs);
  t.after(() => {
    if (previous.options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous.options;
    if (previous.clock === undefined) delete process.env.CLAUDE_FIXTURE_CLOCK_MS; else process.env.CLAUDE_FIXTURE_CLOCK_MS = previous.clock;
  });
}
// --import is inherited only by fixture test children. The bridge worker keeps its
// real process/stream lifecycle; just its test execution clock waits for readiness.
if (process.env.CLAUDE_FIXTURE_CLOCK_MS && process.argv[2] === 'worker') {
  const { workspaceStore, readJob } = await import('../src/state.mjs');
  const value = flag => process.argv[process.argv.indexOf(flag) + 1];
  const store = workspaceStore(process.cwd(), value('--state-dir'));
  const clock = executionClock(store.cwd, () => readJob(store, value('--job')).childPid, Number(process.env.CLAUDE_FIXTURE_CLOCK_MS));
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
}
async function main() {
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.292 (fixture)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'must-not-be-reported@example.invalid' })); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
const marker = readyPath(process.cwd(), process.pid);
const descendant = prompt.endsWith('DESCENDANT_HANG') ? spawn('sleep', ['120'], { stdio: 'ignore' }) : null;
fs.writeFileSync(`${marker}.tmp`, JSON.stringify({ pid: process.pid, descendantPid: descendant?.pid, waitingForRelease: prompt.endsWith('WAIT'), readyAt: Date.now() }));
fs.renameSync(`${marker}.tmp`, marker);
const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : randomUUID();
const send = data => console.log(JSON.stringify(data));
send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5' });
send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'SECRET_THINKING_DO_NOT_SAVE' }] } });
send({ type: 'future_protocol_event', private_data: 'SECRET_UNKNOWN_DO_NOT_SAVE' });
if (prompt.endsWith('BAD_JSON')) { console.log('bad output'); }
else if (prompt.endsWith('NULL_JSON')) { console.log('null'); }
else if (prompt.endsWith('OUTPUT_LIMIT')) { process.stdout.write('x'.repeat(1024 * 1024 + 1)); }
else {
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'sentinel.txt' } }] } });
  if (prompt.endsWith('WRITE_THEN_HANG') && args[args.indexOf('--tools')+1].split(',').includes('Write')) fs.writeFileSync(path.resolve('partial.txt'),'partial edit\n');
  if (prompt.endsWith('HANG')) { setInterval(() => {}, 1000); }
  else {
    if (prompt.endsWith('DETACHED_CHILD')) {
      // Mimics Claude Code's Bash tool: a shell in its own group backgrounds a process, then exits.
      const pidFile = path.resolve(process.cwd(), '..', `.fake-claude-${process.pid}.detached`);
      const shell = spawn('/bin/sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; sleep 1.5`], { detached: true, stdio: 'ignore' });
      await new Promise(resolve => shell.once('exit', resolve));
    }
    if (prompt.endsWith('WAIT')) {
      while (!fs.existsSync(`${marker}.release`)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const slow = prompt.endsWith('SLOW') || prompt.endsWith('FRAGMENT');
    if (slow) await new Promise(resolve => setTimeout(resolve, 350));
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'not persisted' }] } });
    if (prompt.endsWith('WRITE_FILE') && args[args.indexOf('--tools') + 1].split(',').includes('Write')) fs.writeFileSync(path.resolve('delegated.txt'), 'fixture implementation\n');
    const result = JSON.stringify({
      type: 'result', subtype: prompt.endsWith('FAIL') ? 'error_during_execution' : 'success',
      is_error: prompt.endsWith('FAIL'), session_id: sessionId,
      result: JSON.stringify({ args, prompt, resumed: resumeIndex >= 0, unicode: 'café 漢字' }), modelUsage: { 'claude-opus-5-5': {} },
      structured_output: args.includes('--json-schema') ? (prompt.endsWith('BAD_SCHEMA') ? { invalid: true } : (JSON.parse(args[args.indexOf('--json-schema')+1]).properties.findings ? { summary: 'Fixture review', completion: 'completed', uncertainties: [], findings: [] } : { summary:'Fixture task', completion:prompt.endsWith('CLAIM_INCOMPLETE')?'incomplete':'completed', changes:[], checks:prompt.endsWith('FAILED_CHECK')?[{command:'test',outcome:'failed',detail:'fixture failure'}]:[], uncertainties:[], unverifiedClaims:[] })) : undefined,
      permission_denials: prompt.endsWith('DENIED') ? [{ tool_name: 'Write', input: 'not persisted' }] : [],
    }) + '\n';
    if (prompt.endsWith('FRAGMENT')) {
      const bytes = Buffer.from(result);
      for (let i = 0; i < bytes.length; i += 7) process.stdout.write(bytes.subarray(i, i + 7));
    } else process.stdout.write(result);
  }
}

}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
