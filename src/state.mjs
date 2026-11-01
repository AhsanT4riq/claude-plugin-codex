import fs from 'node:fs';
import { finishEvidence, resultContract } from './evidence.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const active = job => ['queued', 'running'].includes(job.status);
let cachedBootIdentity;
export function bootIdentity() {
  if (cachedBootIdentity !== undefined) return cachedBootIdentity;
  try {
    const value = process.platform === 'linux'
      ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      : spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 1000 }).stdout?.trim();
    cachedBootIdentity = /^[0-9a-f-]{36}$/i.test(value || '') ? value : null;
  } catch { cachedBootIdentity = null; }
  return cachedBootIdentity;
}
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// A group can outlive its leader. Never infer group death from leader death.
export function leaderStartTime(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C' } });
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  } catch { return null; }
}
export function processGroupIdentity(pid) {
  return { pgid: pid, leaderPid: pid, leaderStartTime: leaderStartTime(pid), bootId: bootIdentity() };
}
// Claude Code's Bash tool runs each command in its own process group, so the CLI group does not
// cover processes Claude backgrounds. The worker samples the CLI's process tree while it runs and
// records those other groups; anything later found in them is treated as the job's survivor.
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s*$/;
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,lstart='];
const PS_OPTIONS = { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } };
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(PS_ROW);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), startTime: m[4].replace(/\s+/g, ' ') });
  }
  return rows;
}
// null means the table is unavailable, which callers must treat as unknown, not empty.
export function processTable() {
  if (process.platform === 'win32') return null;
  try {
    const result = spawnSync('ps', PS_ARGS, PS_OPTIONS);
    return result.status === 0 ? parseProcessTable(result.stdout) : null;
  } catch { return null; }
}
export function processTableAsync() {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise(resolve => execFile('ps', PS_ARGS, PS_OPTIONS, (error, stdout) => resolve(error ? null : parseProcessTable(stdout))));
}
export function descendantsOf(rootPid, rows) {
  const children = new Map();
  for (const row of rows) { if (!children.has(row.ppid)) children.set(row.ppid, []); children.get(row.ppid).push(row); }
  const found = [], queue = [rootPid], seen = new Set(queue);
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid); found.push(child); queue.push(child.pid);
    }
  }
  return found;
}
// Returns true when the record changed and should be persisted.
export function recordDescendants(job, rows) {
  if (!job.childPid || !rows) return false;
  const cliGroup = job.processGroup?.pgid;
  const groups = job.detachedGroups ||= [];
  let changed = false;
  for (const row of descendantsOf(job.childPid, rows)) {
    if (row.pgid !== cliGroup && row.pgid > 1 && !groups.includes(row.pgid) && groups.length < 64) { groups.push(row.pgid); changed = true; }
  }
  return changed;
}
// A recorded group number can be reused later, so only members started after the job count.
// Linux ps derives start times from a whole-second boot time and truncates again, so they can
// read up to ~2s early. Compare against the CLI leader's ps start time, which has the same error.
export function surviveSince(job) {
  const leader = Date.parse(job.processGroup?.leaderStartTime ?? '');
  return Number.isFinite(leader) ? leader : Date.parse(job.startedAt || job.createdAt) - 2000;
}
export function trackedSurvivors(job, rows = processTable()) {
  if (!job.detachedGroups?.length) return [];
  if (!rows) return null;
  const since = surviveSince(job);
  return rows.filter(row => job.detachedGroups.includes(row.pgid) && row.pid !== process.pid && Date.parse(row.startTime) >= since);
}
// Stops processes Claude detached into other groups. Each signal re-checks identity first.
export async function stopTrackedSurvivors(job, { graceMs = 2000 } = {}) {
  const initial = trackedSurvivors(job);
  if (!initial?.length) return initial;
  const settle = async ms => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      const left = trackedSurvivors(job);
      if (left && !left.length) return left;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return trackedSurvivors(job);
  };
  const signalAll = signal => { for (const row of trackedSurvivors(job) || []) { try { process.kill(row.pid, signal); } catch {} } };
  signalAll('SIGTERM');
  let left = await settle(graceMs);
  if (left?.length) { signalAll('SIGKILL'); left = await settle(500); }
  const remaining = new Set((left || initial).map(row => row.pid));
  job.detachedProcesses = initial.map(row => ({ pid: row.pid, pgid: row.pgid, startTime: row.startTime, stopped: !remaining.has(row.pid) }));
  return left;
}
export function groupMayBeRunning(job, currentBoot = bootIdentity()) {
  const recordedBoot = job.processGroup?.bootId ?? job.bootId;
  if (currentBoot && recordedBoot && currentBoot !== recordedBoot) return false;
  if (cliGroupMayBeRunning(job)) return true;
  const survivors = trackedSurvivors(job);
  return survivors === null || survivors.length > 0;
}
function cliGroupMayBeRunning(job) {
  const group = job.processGroup;
  // Legacy records have no reliable group id; an orphan with unknown identity stays locked.
  if (!group) {
    if (!job.childPid) return !!job.childMayBeRunning;
    if (alive(job.childPid)) return true;
    try { process.kill(-job.childPid, 0); return true; }
    catch (e) { return e.code !== 'ESRCH'; }
  }
  if (!Number.isSafeInteger(group.pgid) || group.pgid < 1) return true;
  try { process.kill(-group.pgid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}
export function groupIdentityMatches(group, current = processGroupIdentity(group?.leaderPid)) {
  if (!group || !Number.isSafeInteger(group.pgid) || group.pgid < 1 || group.pgid !== group.leaderPid) return false;
  return current.pgid === group.pgid && current.leaderPid === group.leaderPid && !!current.bootId && current.bootId === group.bootId && !!group.leaderStartTime && current.leaderStartTime === group.leaderStartTime;
}
// Re-check the OS identity immediately before signalling a recorded group.
export function signalProcessGroup(group, signal) {
  if (!groupIdentityMatches(group)) return false;
  try { process.kill(-group.pgid, signal); return true; }
  catch (e) { return e.code === 'ESRCH'; }
}
export function workspaceStore(cwd, stateRoot) {
  const canonical = fs.realpathSync(cwd);
  const git = spawnSync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 });
  const workspace = git.status === 0 ? fs.realpathSync(git.stdout.trim()) : canonical;
  const root = path.resolve(stateRoot || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'claude-plugin-codex'));
  const dir = path.join(root, createHash('sha256').update(workspace).digest('hex').slice(0, 24));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { cwd: canonical, workspace, root, dir };
}
export function artifact(store, id, suffix = '.json') {
  if (!UUID.test(id || '')) throw new Error('An exact job UUID is required.');
  if (!['.json', '.request.json', '.cancel', '.worker.log'].includes(suffix)) throw new Error('Invalid job artifact.');
  return path.join(store.dir, `${id}${suffix}`);
}
export function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function saveJob(store, job) {
  if (job.status === 'cancelled') job.failure = { kind: 'cancelled', message: job.error || 'Delegation cancelled. Edits are not undone.' };
  atomicJson(artifact(store, job.id), job);
}
export function readJob(store, id) { return JSON.parse(fs.readFileSync(artifact(store, id), 'utf8')); }
export function listJobs(store, ownerId) {
  return fs.readdirSync(store.dir).filter(n => n.endsWith('.json') && UUID.test(n.slice(0, -5)))
    .map(n => readJob(store, n.slice(0, -5)))
    .filter(j => !ownerId || j.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function readLock(store) {
  try { return JSON.parse(fs.readFileSync(path.join(store.dir, 'active.lock', 'owner.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function ownsLock(store, job) {
  const lock = readLock(store);
  return !!lock && lock.jobId === job.id && lock.token === job.lockToken;
}
export function releaseLock(store, job) {
  if (job.processGroup) {
    job.childMayBeRunning = groupMayBeRunning(job);
    if (job.childMayBeRunning) return;
  }
  if (ownsLock(store, job)) fs.rmSync(path.join(store.dir, 'active.lock'), { recursive: true });
}
export function reconcile(store, id) {
  const job = readJob(store, id);
  if (job.version !== 2) return job;
  const currentBoot = bootIdentity();
  const rebooted = !!currentBoot && !!job.bootId && currentBoot !== job.bootId;
  const starting = job.status === 'queued' && Date.now() - Date.parse(job.createdAt) < 10_000;
  if (active(job)) {
    const ownerAlive = !rebooted && alive(job.workerPid || job.ownerPid);
    if (ownerAlive || (!rebooted && starting)) return job;
    job.status = 'interrupted'; job.phase = 'interrupted';
    job.finishedAt = new Date().toISOString();
  } else if (!job.childMayBeRunning && !ownsLock(store, job)) return job;
  job.childMayBeRunning = groupMayBeRunning(job);
  if (job.status === 'interrupted') {
    job.error = job.childMayBeRunning
      ? 'Worker exited; Claude or its descendants may still be running. Workspace remains locked. Stop the orphan before starting another job.'
      : 'Worker exited before final completion. No automatic replay was attempted.';
    job.failure = { kind: 'interrupted', message: job.error };
  }
  if (!job.childMayBeRunning) finishEvidence(job, job.cwd);
  job.report = resultContract(job);
  saveJob(store, job);
  if (!job.childMayBeRunning) {
    releaseLock(store, job);
    fs.rmSync(artifact(store, id, '.request.json'), { force: true });
  }
  return job;
}
export function acquireLock(store, job) {
  const lockDir = path.join(store.dir, 'active.lock');
  if (fs.existsSync(lockDir)) {
    const lock = readLock(store);
    if (lock) {
      try {
        const old = reconcile(store, lock.jobId);
        // An interrupted orphan may have finished since the last inspection.
        if (!active(old) && !old.childMayBeRunning && !groupMayBeRunning(old) && !alive(old.workerPid || old.ownerPid)) releaseLock(store, old);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  try { fs.mkdirSync(lockDir, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another delegation holds this workspace lock. Inspect status; do not edit concurrently.'); throw e; }
  try { atomicJson(path.join(lockDir, 'owner.json'), { jobId: job.id, token: job.lockToken }); }
  catch (e) { fs.rmSync(lockDir, { recursive: true, force: true }); throw e; }
}
export function publicJob(job) {
  const { lockToken, ...view } = job;
  return view;
}

export function statusView(job) {
  const { result, stderr, rawOutput, events, report, evidence, structuredOutput, review, ...view } = publicJob(job);
  // With a structured contract, result is the raw JSON text; its summary field is the readable one.
  const summary = structuredOutput?.summary ?? review?.summary ?? result;
  if (typeof summary === 'string') view.summary = summary.split('\n').find(line => line.trim())?.slice(0, 240) || '';
  if (view.error) view.error = String(view.error).slice(0, 1000);
  return view;
}
