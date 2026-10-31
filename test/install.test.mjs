import { waitForReady, backgroundExecutionFromReadiness } from './fake-claude.fixture.mjs';
import { readJob } from '../src/state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, installationStatus, SKILLS, bundleFiles } from '../scripts/install.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
function context(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { codexHome: path.join(root, 'codex'), sourceRoot: source };
}
test('clean install is self-contained and all seven skill resources resolve', t => {
  const options = context(t); const result = install('install', options);
  assert.equal(result.installed, true); assert.deepEqual(result.skills, SKILLS);
  for (const skill of SKILLS) {
    const real = fs.realpathSync(path.join(result.skillsDir, skill));
    const runtime = path.resolve(real, '../../bin/claude-companion.mjs');
    assert.ok(fs.existsSync(path.join(real, 'SKILL.md'))); assert.ok(fs.existsSync(path.resolve(real, '../runtime.md')));
    const proc = spawnSync(process.execPath, [runtime, '--help'], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(proc.status, 0); assert.match(proc.stdout, /background/);
  }
  assert.equal(installationStatus(options).missingSkills.length, 0);
  const status = spawnSync(process.execPath, [path.join(result.root, 'current', 'scripts/install.mjs'), 'status', '--codex-home', options.codexHome], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).installed, true);
  assert.equal(install('install', options).changed, false);
});
test('installer refuses unrelated directories and dangling skill symlinks', t => {
  const options = context(t); const skillsDir = path.join(options.codexHome, 'skills'); fs.mkdirSync(skillsDir, { recursive: true });
  const conflict = path.join(skillsDir, 'claude-rescue'); fs.symlinkSync('/no/such/unrelated-skill', conflict);
  assert.throws(() => install('install', options), /Skill conflict/);
  assert.equal(fs.readlinkSync(conflict), '/no/such/unrelated-skill');
});
test('updates switch immutable bundles while preserving unrelated skills and history', t => {
  const options = context(t); const first = install('install', options);
  const other = path.join(first.skillsDir, 'unrelated-skill'); fs.mkdirSync(other);
  const history = path.join(options.codexHome, 'job-history.json'); fs.writeFileSync(history, 'preserve');
  const updatedSource = path.join(options.codexHome, 'new-source'); fs.mkdirSync(updatedSource);
  for (const file of bundleFiles(source)) { const target = path.join(updatedSource, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(source, file), target); }
  fs.appendFileSync(path.join(updatedSource, 'skills/runtime.md'), '\nUpdated fixture.\n');
  const second = install('update', { ...options, sourceRoot: updatedSource });
  assert.notEqual(second.current, first.current); assert.ok(fs.existsSync(path.join(first.root, 'releases', first.current)));
  assert.equal(fs.readFileSync(history, 'utf8'), 'preserve'); assert.ok(fs.existsSync(other));
  const removed = install('uninstall', options); assert.equal(removed.historyPreserved, true);
  assert.equal(fs.existsSync(first.root), false); assert.equal(fs.readFileSync(history, 'utf8'), 'preserve'); assert.ok(fs.existsSync(other));
});
test('modified links or installed files cannot be overwritten or deleted', t => {
  const options = context(t); const result = install('install', options);
  const file = path.join(result.root, 'current', 'skills/runtime.md'); fs.appendFileSync(file, '\nPersonal edit.\n');
  assert.throws(() => install('uninstall', options), /Modified installed file/);
  assert.ok(fs.existsSync(path.join(result.skillsDir, 'claude-rescue')));
  const link = path.join(result.skillsDir, 'claude-review'); fs.unlinkSync(link); fs.mkdirSync(link);
  assert.throws(() => install('update', options), /Skill conflict/);
  assert.ok(fs.existsSync(link));
});
test('unowned root and changed current pointer are rejected before mutation', t => {
  const options = context(t); const root = path.join(options.codexHome, 'claude-plugin-codex'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'personal.txt'), 'keep');
  assert.throws(() => install('install', options), /not owned/);
  assert.equal(fs.readFileSync(path.join(root, 'personal.txt'), 'utf8'), 'keep');
  fs.rmSync(root, { recursive: true });
  const result = install('install', options); fs.unlinkSync(path.join(result.root, 'current')); fs.symlinkSync('/unrelated', path.join(result.root, 'current'));
  assert.throws(() => install('update', options), /modified/);
});

test('uninstall preserves unexpected user files rather than deleting an installation blindly', t => {
  const options = context(t); const result = install('install', options);
  fs.writeFileSync(path.join(result.root, 'personal-note.txt'), 'keep');
  assert.throws(() => install('uninstall', options), /Unknown installation-root files/);
  assert.equal(fs.readFileSync(path.join(result.root, 'personal-note.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(result.skillsDir, 'claude-rescue')));
});
test('concurrent installers are refused before modifying any skill', t => {
  const options = context(t); const lock = path.join(options.codexHome, 'claude-plugin-codex.install-lock');
  fs.mkdirSync(lock, { recursive: true });
  assert.throws(() => install('install', options), /Another installer/);
  assert.equal(fs.existsSync(path.join(options.codexHome, 'skills')), false);
});
test('an installed background worker survives a bundle update and its result survives uninstall', async t => {
  backgroundExecutionFromReadiness(t, 8000);
  const options = context(t); const first = install('install', options);
  const target = path.join(options.codexHome, 'target'); fs.mkdirSync(target);
  const stateDir = path.join(options.codexHome, 'history');
  const fixture = path.join(source, 'test', 'fake-claude.fixture.mjs');
  const cli = path.join(first.root, 'current', 'bin', 'claude-companion.mjs');
  const launch = spawnSync(process.execPath, [cli, 'rescue', '--background', '--cwd', target, '--state-dir', stateDir, '--prompt', 'HANG', '--timeout', '8'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_BINARY: fixture }, timeout: 15_000,
  });
  assert.equal(launch.status, 0, launch.stderr); const id = JSON.parse(launch.stdout).id;
  const { workspaceStore, resultJob, cancelJob } = await import('../src/runtime.mjs');
  const store = workspaceStore(target, stateDir);
  async function until(fn) {
    const end = Date.now() + 7000;
    while (Date.now() < end) { const result = fn(); if (result) return result; await new Promise(r => setTimeout(r, 25)); }
    throw new Error('Timed out waiting for installed worker.');
  }
  try {
    await waitForReady(target, () => readJob(store, id).childPid);
    await until(() => resultJob(store, id).sessionId);
    const newSource = path.join(options.codexHome, 'updated-source'); fs.mkdirSync(newSource);
    for (const file of bundleFiles(source)) { const out = path.join(newSource, file); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(path.join(source, file), out); }
    fs.appendFileSync(path.join(newSource, 'skills/runtime.md'), '\nUpdate during fixture execution.\n');
    const updated = install('update', { ...options, sourceRoot: newSource });
    assert.notEqual(first.current, updated.current);
    cancelJob(store, id);
    const terminal = await until(() => { const j = resultJob(store, id); return j.status !== 'running' && j.status !== 'queued' && j; });
    assert.equal(terminal.status, 'cancelled'); assert.ok(terminal.sessionId);
    install('uninstall', options);
    assert.equal(resultJob(store, id).status, 'cancelled');
  } finally {
    const job = resultJob(store, id);
    if (['queued', 'running'].includes(job.status)) { cancelJob(store, id); await until(() => !['queued', 'running'].includes(resultJob(store, id).status)); }
  }
});
