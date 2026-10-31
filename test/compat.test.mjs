import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delegate, launchBackground, statusJob, workspaceStore, listJobs, setup, buildClaudeArgs } from '../src/runtime.mjs';
import { checkCompatibility, resolveExecutable } from '../src/compat.mjs';

const failures = fileURLToPath(new URL('./fake-claude-failures.fixture.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fake-claude.fixture.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../bin/claude-companion.mjs', import.meta.url));
function context(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compat-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  return { root, cwd, stateDir: path.join(root, 'state'), kind: 'rescue', prompt: 'Inspect', timeoutMs: 5000 };
}
// A launcher that runs the failure fixture with extra environment, so no test mutates process.env.
function launcher(root, name, env) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\nObject.assign(process.env, ${JSON.stringify(env)});\nawait import(${JSON.stringify(failures)});\n`, { mode: 0o755 });
  return file;
}
const leftovers = (store) => fs.readdirSync(store.dir).filter(n => n === 'active.lock' || n.endsWith('.request.json') || n.endsWith('.json'));

test('an old CLI that rejects --safe-mode fails with incompatible_cli before any lease, request or job exists', async t => {
  const o = context(t);
  const old = launcher(o.root, 'old-claude', { FAKE_CLAUDE_OLD: '1', FAKE_CLAUDE_VERSION: '2.1.3' });
  await assert.rejects(delegate({ ...o, binary: old }), e => {
    assert.equal(e.failure.kind, 'incompatible_cli');
    assert.match(e.message, /--safe-mode/); assert.match(e.message, /2\.1\.3/);
    return true;
  });
  await assert.rejects(launchBackground({ ...o, binary: old }), e => e.failure.kind === 'incompatible_cli');
  assert.deepEqual(leftovers(workspaceStore(o.cwd, o.stateDir)), []);
  assert.deepEqual(listJobs(workspaceStore(o.cwd, o.stateDir)), []);
});
test('every unsupported flag is reported and isolation flags are never dropped from the real launch', t => {
  const o = context(t);
  const old = launcher(o.root, 'older-claude', { FAKE_CLAUDE_REJECT: '--safe-mode,--restricted,--permission-prompts' });
  const args = buildClaudeArgs({ kind: 'rescue' });
  assert.throws(() => checkCompatibility(old, args, { cwd: o.cwd }), e => e.failure.kind === 'incompatible_cli' && /--safe-mode, --restricted, --permission-prompts/.test(e.message));
  const result = setup(old, o.cwd);
  assert.equal(result.available, false); assert.equal(result.binary.compatible, false);
  assert.deepEqual(result.binary.missingCapabilities, ['--safe-mode', '--restricted', '--permission-prompts']);
  assert.ok(args.includes('--safe-mode') && args.includes('--restricted'));
});
test('a missing binary fails with missing_cli and leaves no state, in foreground and background', async t => {
  const o = context(t);
  const missing = path.join(o.root, 'nope');
  for (const launch of [delegate, launchBackground]) await assert.rejects(launch({ ...o, binary: missing }), e => e.failure.kind === 'missing_cli' && e.message.includes('CLAUDE_CODE_BINARY'));
  assert.deepEqual(leftovers(workspaceStore(o.cwd, o.stateDir)), []);
  const result = setup(missing, o.cwd);
  assert.equal(result.available, false); assert.equal(result.binary.path, null);
  const named = { ...process.env, PATH: o.root };
  assert.equal(resolveExecutable('claude-not-installed', named), null);
  assert.equal(resolveExecutable('old-claude-x', named), null);
});
test('PATH lookup is used when no override is given, and a non-executable file is not selected', t => {
  const o = context(t);
  const exe = launcher(o.root, 'claude-on-path', {});
  const plain = path.join(o.root, 'plain'); fs.writeFileSync(plain, 'x', { mode: 0o644 });
  assert.equal(resolveExecutable('claude-on-path', { PATH: o.root }), exe);
  assert.equal(resolveExecutable('plain', { PATH: o.root }), null);
});
test('a compatible override runs in the foreground and records job.binary', async t => {
  const o = context(t);
  const job = await delegate({ ...o, binary: fixture });
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.binary, { path: fixture, version: '2.1.292 (fixture)', compatible: true, missingCapabilities: [] });
});
test('a compatible CLAUDE_CODE_BINARY override runs a background job through the real worker', async t => {
  const o = context(t);
  const launched = spawnSync(process.execPath, [cli, 'rescue', '--cwd', o.cwd, '--state-dir', o.stateDir, '--prompt', 'Inspect', '--background'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_BINARY: fixture } });
  assert.equal(launched.status, 0, launched.stderr);
  const store = workspaceStore(o.cwd, o.stateDir), id = JSON.parse(launched.stdout).id;
  let job;
  for (let i = 0; i < 100; i++) { job = await statusJob(store, id); if (!['queued', 'running'].includes(job.status)) break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(job.status, 'completed'); assert.equal(job.binary.path, fixture); assert.equal(job.binary.compatible, true);
});
test('the CLI reports incompatibility as a structured failure and setup reports the selected binary', t => {
  const o = context(t);
  const old = launcher(o.root, 'old-claude', { FAKE_CLAUDE_OLD: '1', FAKE_CLAUDE_VERSION: '2.1.3 (Claude Code)' });
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_BINARY: old } });
  const bad = run(['rescue', '--cwd', o.cwd, '--state-dir', o.stateDir, '--prompt', 'x']);
  assert.equal(bad.status, 1); assert.equal(JSON.parse(bad.stderr).failure.kind, 'incompatible_cli');
  const status = run(['setup', '--cwd', o.cwd]);
  assert.equal(status.status, 1);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.binary.compatible, false); assert.deepEqual(parsed.binary.missingCapabilities, ['--safe-mode']);
  assert.equal(parsed.binary.path, old);
  assert.equal(parsed.binary.version, '2.1.3 (Claude Code)', 'An incompatible CLI still reports the version it printed.');
});
test('compatibility results are cached by path and modification time', t => {
  const o = context(t);
  const counter = path.join(o.root, 'count'); fs.writeFileSync(counter, '');
  const exe = path.join(o.root, 'counting-claude');
  fs.writeFileSync(exe, `#!/bin/sh\necho x >> ${JSON.stringify(counter)}\nif [ "$1" = "--version" ]; then echo 2.1.292; else echo "error: unknown option '--bridge-compat-probe'" >&2; exit 1; fi\n`, { mode: 0o755 });
  const args = buildClaudeArgs({ kind: 'rescue' });
  const calls = () => fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  checkCompatibility(exe, args, { cwd: o.cwd }); const first = calls();
  checkCompatibility(exe, args, { cwd: o.cwd }); assert.equal(calls(), first);
  const later = new Date(Date.now() + 5000); fs.utimesSync(exe, later, later);
  checkCompatibility(exe, args, { cwd: o.cwd }); assert.ok(calls() > first);
});
