import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizeTail, firstLine } from './diagnostics.mjs';

// Compatibility gate: resolve the executable and prove it parses the flags we are about to launch with,
// without starting a model. Isolation flags are never removed from a real launch to satisfy an old CLI.
const PROBE_FLAG = '--bridge-compat-probe';
const cache = new Map();

function failure(kind, message) { return Object.assign(new Error(message), { failure: { kind, message } }); }

export function resolveExecutable(binary, env = process.env) {
  const name = String(binary || 'claude');
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD').split(';')] : [''];
  const executable = file => {
    try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
  };
  const candidates = name.includes('/') || name.includes(path.sep)
    ? [path.resolve(name)]
    : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name));
  for (const base of candidates) for (const ext of exts) if (executable(base + ext)) return base + ext;
  return null;
}

// Flags that make a value-taking option consume the next token; the last `-p` carries the stdin prompt.
function stripFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return args;
  const next = args[index + 1];
  const hasValue = next !== undefined && !next.startsWith('--') && next !== '-p';
  return [...args.slice(0, index), ...args.slice(index + (hasValue ? 2 : 1))];
}
function rejectedFlag(output) {
  const text = String(output || '');
  const patterns = [
    /(?:unknown|unrecognized|unsupported)\s+(?:option|argument|flag)s?:?\s+['"`]?(--[A-Za-z0-9][A-Za-z0-9-]*)/i,
    /option\s+['"`](--[A-Za-z0-9][A-Za-z0-9-]*)[^'"`]*['"`]\s+argument\b[^\n]*invalid/i,
  ];
  for (const pattern of patterns) { const match = text.match(pattern); if (match) return match[1]; }
  return null;
}

function probe(binary, args, cwd, env) {
  const missing = [];
  let current = args;
  for (let round = 0; round < 24; round++) {
    const run = spawnSync(binary, [...current, PROBE_FLAG], { cwd, env, encoding: 'utf8', input: '', timeout: 15_000, maxBuffer: 256 * 1024 });
    if (run.error) return { missing, error: run.error.code === 'ETIMEDOUT' ? 'Probe timed out.' : run.error.message };
    const flag = rejectedFlag(`${run.stderr}\n${run.stdout}`);
    if (!flag || flag === PROBE_FLAG) return { missing };
    if (missing.includes(flag)) return { missing };
    missing.push(flag);
    if (!current.includes(flag)) return { missing };
    current = stripFlag(current, flag);
  }
  return { missing };
}

export function checkCompatibility(binary, args, { cwd = process.cwd(), env = process.env } = {}) {
  const resolved = resolveExecutable(binary, env);
  if (!resolved) {
    const where = String(binary).includes('/') ? `at ${binary}` : 'on PATH';
    throw failure('missing_cli', `Claude Code CLI '${binary}' was not found ${where}. Install Claude Code or set CLAUDE_CODE_BINARY to its absolute path.`);
  }
  const stat = fs.statSync(resolved);
  const flags = args.filter(arg => arg.startsWith('-')).join(',');
  const key = `${resolved}\0${stat.mtimeMs}\0${stat.size}\0${flags}`;
  let entry = cache.get(key);
  if (!entry) {
    const version = spawnSync(resolved, ['--version'], { cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
    if (version.error || version.status !== 0) {
      const why = version.error?.message || firstLine(sanitizeTail(version.stderr, 512)) || `exit ${version.status}`;
      throw failure('incompatible_cli', `Claude Code CLI at ${resolved} did not report a version (${why}).`);
    }
    const found = probe(resolved, args, cwd, env);
    entry = { version: firstLine(version.stdout, 100) || null, missingCapabilities: found.missing, probeError: found.error || null };
    if (!entry.probeError) cache.set(key, entry);
  }
  const binaryInfo = { path: resolved, version: entry.version, compatible: !entry.missingCapabilities.length && !entry.probeError, missingCapabilities: [...entry.missingCapabilities] };
  if (!binaryInfo.compatible) {
    const detail = entry.probeError ? `its option probe failed (${entry.probeError})` : `it does not support: ${entry.missingCapabilities.join(', ')}`;
    throw Object.assign(failure('incompatible_cli', `Claude Code CLI at ${resolved}${entry.version ? ` (${entry.version})` : ''} is not compatible: ${detail}. Update Claude Code or set CLAUDE_CODE_BINARY to a newer executable; the bridge never drops isolation flags.`), { binary: binaryInfo });
  }
  return binaryInfo;
}

// Same probe, but reports instead of throwing. Used by setup.
export function inspectCompatibility(binary, args, options) {
  try { return { ...checkCompatibility(binary, args, options) }; }
  catch (e) {
    if (!e.failure) throw e;
    // An incompatible binary still reports what the probe learned; only a missing or silent one has no version.
    if (e.binary) return { ...e.binary, failure: e.failure };
    return { path: resolveExecutable(binary, options?.env), version: null, compatible: false, missingCapabilities: [], failure: e.failure };
  }
}
