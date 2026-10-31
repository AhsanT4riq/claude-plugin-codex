#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson } from '../src/state.mjs';

export const SKILLS = ['claude-rescue', 'claude-review', 'claude-adversarial-review', 'claude-setup', 'claude-status', 'claude-result', 'claude-cancel'];
const OWNER = 'claude-plugin-codex-local-installation';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function lstat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function inside(root, relative) {
  const result = path.resolve(root, relative);
  if (!relative || path.isAbsolute(relative) || result === root || !result.startsWith(root + path.sep)) throw new Error('Unsafe installation manifest path.');
  return result;
}
function treeFiles(dir, prefix = '') {
  if (!lstat(dir)?.isDirectory() || lstat(dir).isSymbolicLink()) throw new Error('Runtime bundle directories must not be symlinks.');
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in runtime bundle: ${relative}`);
    if (entry.isDirectory()) files.push(...treeFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported bundle entry: ${relative}`);
  }
  return files.sort();
}
export function bundleFiles(root = sourceRoot) {
  const files = ['README.md', 'LICENSE', 'package.json', 'package-lock.json'];
  for (const dir of ['src', 'bin', 'skills']) files.push(...treeFiles(path.join(root, dir)).map(p => `${dir}/${p}`));
  files.push('scripts/install.mjs');
  for (const file of files) if (!lstat(path.join(root, file))?.isFile()) throw new Error(`Missing regular bundle file: ${file}`);
  return files.sort();
}
export function locations(options = {}) {
  const codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  return { root: path.join(codexHome, 'claude-plugin-codex'), skillsDir: path.resolve(options.skillsDir || path.join(codexHome, 'skills')) };
}
function manifestAt(root) {
  const entry = lstat(root);
  if (!entry) return null;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Installation root is not an owned directory.');
  const file = path.join(root, 'installation.json');
  if (!lstat(file)?.isFile() || lstat(file).isSymbolicLink()) throw new Error('Existing installation directory is not owned by this installer.');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.owner !== OWNER || data.format !== 1 || !Array.isArray(data.releases) || !path.isAbsolute(data.skillsDir || '')) throw new Error('Invalid installation ownership manifest.');
  for (const release of data.releases) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,100}$/.test(release.name) || !release.files || typeof release.files !== 'object') throw new Error('Invalid release ownership manifest.');
    for (const name of Object.keys(release.files)) inside(path.join(root, 'releases', release.name), name);
  }
  if (!data.releases.some(r => r.name === data.current)) throw new Error('Installation manifest has no current release.');
  return data;
}
function targetFor(root, skill) { return path.join(root, 'current', 'skills', skill); }
function checkSkillLinks(root, skillsDir, existing) {
  for (const skill of SKILLS) {
    const link = path.join(skillsDir, skill); const entry = lstat(link);
    if (!entry) continue;
    if (!existing || !entry.isSymbolicLink() || path.resolve(skillsDir, fs.readlinkSync(link)) !== targetFor(root, skill)) {
      throw new Error(`Skill conflict; refusing to overwrite: ${link}`);
    }
  }
}
function checkCurrent(root, manifest) {
  const current = path.join(root, 'current');
  const entry = lstat(current);
  if (!entry?.isSymbolicLink() || path.resolve(root, fs.readlinkSync(current)) !== path.join(root, 'releases', manifest.current)) throw new Error('Current release link was modified; refusing to replace it.');
}
function verifyRelease(root, release) {
  const dir = path.join(root, 'releases', release.name);
  if (!lstat(dir)?.isDirectory() || lstat(dir).isSymbolicLink()) throw new Error('Release directory was replaced.');
  const actual = treeFiles(dir);
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(release.files).sort())) throw new Error(`Unknown or missing files in owned release: ${release.name}`);
  for (const file of actual) if (digest(fs.readFileSync(inside(dir, file))) !== release.files[file]) throw new Error(`Modified installed file; refusing to remove it: ${file}`);
}
function switchCurrent(root, name) {
  const temporary = path.join(root, `.current-${randomUUID()}`);
  try { fs.symlinkSync(path.join('releases', name), temporary, 'dir'); fs.renameSync(temporary, path.join(root, 'current')); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function installationStatus(options = {}) {
  const loc = locations(options); const manifest = manifestAt(loc.root);
  if (!manifest) return { installed: false, ...loc };
  checkCurrent(loc.root, manifest); checkSkillLinks(loc.root, manifest.skillsDir, true);
  const missingSkills = SKILLS.filter(s => !lstat(path.join(manifest.skillsDir, s)));
  return { installed: true, root: loc.root, skillsDir: manifest.skillsDir, version: manifest.version, current: manifest.current, missingSkills };
}
export function install(command = 'install', options = {}) {
  if (!['install', 'update', 'uninstall'].includes(command)) throw new Error('Expected install, update, or uninstall.');
  const { root, skillsDir } = locations(options);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const lock = `${root}.install-lock`;
  try { fs.mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error('Another installer holds the installation lock.'); throw e; }
  let createdRoot = false, staged = null, old = null, switched = false, createdRelease = null;
  const createdLinks = [];
  try {
    old = manifestAt(root);
    if (command === 'update' && !old) throw new Error('No owned installation exists to update.');
    if (old && old.skillsDir !== skillsDir) throw new Error('Use the original skills directory when updating/removing this installation.');
    checkSkillLinks(root, skillsDir, !!old);
    if (old) checkCurrent(root, old);
    if (command === 'uninstall') {
      if (!old) return { installed: false, changed: false, root, historyPreserved: true };
      const top = fs.readdirSync(root).sort();
      if (JSON.stringify(top) !== JSON.stringify(['current', 'installation.json', 'releases'])) throw new Error('Unknown installation-root files; refusing to delete them.');
      const releases = fs.readdirSync(path.join(root, 'releases')).sort();
      if (JSON.stringify(releases) !== JSON.stringify(old.releases.map(r => r.name).sort())) throw new Error('Unknown release directory; refusing to delete it.');
      old.releases.forEach(release => verifyRelease(root, release));
      // Validate everything before unlinking any resources. State/history lives outside this root.
      for (const skill of SKILLS) { const link = path.join(skillsDir, skill); if (lstat(link)) fs.unlinkSync(link); }
      fs.rmSync(root, { recursive: true });
      return { installed: false, changed: true, root, historyPreserved: true };
    }
    const source = path.resolve(options.sourceRoot || sourceRoot);
    const files = bundleFiles(source);
    const hashes = Object.fromEntries(files.map(file => [file, digest(fs.readFileSync(path.join(source, file)))]));
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,63}$/.test(pkg.version)) throw new Error('Invalid package version.');
    const name = `${pkg.version}-${digest(JSON.stringify(hashes)).slice(0, 16)}`;
    const release = { name, files: hashes };
    if (!old) { fs.mkdirSync(root); createdRoot = true; fs.mkdirSync(path.join(root, 'releases')); }
    const destination = path.join(root, 'releases', name);
    if (lstat(destination)) {
      const recorded = old?.releases.find(r => r.name === name);
      if (!recorded) throw new Error('Release directory is not owned by the existing manifest.');
      verifyRelease(root, recorded);
    } else {
      staged = path.join(root, 'releases', `.stage-${randomUUID()}`); fs.mkdirSync(staged);
      for (const file of files) {
        const target = inside(staged, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(source, file), target);
        fs.chmodSync(target, file.startsWith('bin/') || file === 'scripts/install.mjs' ? 0o755 : 0o644);
      }
      fs.renameSync(staged, destination); staged = null; createdRelease = release;
    }
    fs.mkdirSync(skillsDir, { recursive: true });
    const next = { owner: OWNER, format: 1, installationId: old?.installationId || randomUUID(), skillsDir, current: name, version: pkg.version,
      releases: [...(old?.releases || []).filter(r => r.name !== name), release] };
    switchCurrent(root, name); switched = true;
    for (const skill of SKILLS) {
      const link = path.join(skillsDir, skill);
      if (!lstat(link)) { fs.symlinkSync(targetFor(root, skill), link, 'dir'); createdLinks.push(link); }
    }
    atomicJson(path.join(root, 'installation.json'), next);
    return { installed: true, changed: !old || old.current !== name || createdLinks.length > 0, root, skillsDir, version: pkg.version, current: name, skills: SKILLS, historyPreserved: true };
  } catch (e) {
    // Roll back only links created by this operation. Never delete a pre-existing resource.
    for (const link of createdLinks) { if (lstat(link)?.isSymbolicLink()) fs.unlinkSync(link); }
    if (staged) fs.rmSync(staged, { recursive: true, force: true });
    if (old && switched) {
      switchCurrent(root, old.current);
      // Keep new immutable releases: a caller could have started a worker during the switch.
      if (createdRelease) old.releases.push(createdRelease);
      atomicJson(path.join(root, 'installation.json'), old);
    } else if (old && createdRelease) {
      verifyRelease(root, createdRelease); fs.rmSync(path.join(root, 'releases', createdRelease.name), { recursive: true });
    } else if (createdRoot) {
      const current = path.join(root, 'current');
      if (lstat(current)?.isSymbolicLink() && createdRelease && path.resolve(root, fs.readlinkSync(current)) === path.join(root, 'releases', createdRelease.name)) fs.unlinkSync(current);
      if (createdRelease) { verifyRelease(root, createdRelease); fs.rmSync(path.join(root, 'releases', createdRelease.name), { recursive: true }); }
      // Empty-directory removal never deletes an unexpected user file.
      for (const dir of [path.join(root, 'releases'), root]) {
        try { fs.rmdirSync(dir); } catch (cleanup) { if (!['ENOTEMPTY', 'ENOENT'].includes(cleanup.code)) throw cleanup; }
      }
    }
    throw e;
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = { '--codex-home': 'codexHome', '--skills-dir': 'skillsDir' }[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--') || key in options) throw new Error(`Invalid installer option: ${args[i]}`);
    options[key] = args[++i];
  }
  console.log(JSON.stringify(command === 'status' ? installationStatus(options) : install(command, options), null, 2));
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; }
}
