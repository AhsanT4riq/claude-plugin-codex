import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEvidence, observe, finishEvidence, resultContract } from './evidence.mjs';
import { collectReview } from './review.mjs';
import { REVIEW_SCHEMA, TASK_SCHEMA, validateSchema, validateReview } from './contracts.mjs';
import { streamCollector } from './stream.mjs';
import { checkCompatibility, inspectCompatibility } from './compat.mjs';
import { sanitizeTail, firstLine, parseUsage } from './diagnostics.mjs';
import { DEFAULT_MODEL, selection, capabilities, selectionOptions } from './options.mjs';
export { DEFAULT_MODEL } from './options.mjs';
import { active, artifact, atomicJson, workspaceStore, saveJob, readJob, listJobs, acquireLock, releaseLock, ownsLock, reconcile, bootIdentity, processGroupIdentity, signalProcessGroup, publicJob, statusView, processTable, processTableAsync, recordDescendants, stopTrackedSurvivors } from './state.mjs';
export { workspaceStore, saveJob, readJob, listJobs } from './state.mjs';

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
export function buildClaudeArgs(options = {}) {
  options = { ...options, ...selection(options) };
  const tools = [...READ_TOOLS, ...(options.write ? ['Edit', 'Write'] : []), ...(options.allowBash ? ['Bash'] : [])];
  const args = [
    '--safe-mode', '--restricted', '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-chrome',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--tools', tools.join(','), '--allowedTools', tools.join(','),
    '--model', options.model || DEFAULT_MODEL, '--output-format', 'stream-json', '--verbose',
  ];
  args.push('--json-schema', JSON.stringify(options.kind === 'rescue' ? TASK_SCHEMA : REVIEW_SCHEMA));
  if (options.sessionId) args.push('--resume', options.sessionId);
  if (options.effort) args.push('--effort', options.effort);
  if (options.maxBudgetUsd) args.push('--max-budget-usd', String(options.maxBudgetUsd));
  args.push('-p'); // Prompt arrives on stdin; it never becomes a shell command or option.
  return args;
}

export function buildPrompt(options) {
  const role = options.kind === 'adversarial-review'
    ? 'Challenge the design and implementation. Investigate assumptions, alternatives, and concrete failure modes.'
    : options.kind === 'review'
      ? 'Review the requested target. Return actionable findings with file references, evidence, and severity.'
      : 'Complete the delegated task within the requested scope. Investigate directly rather than assuming the coordinator inspected the code.';
  return [
    'You are Claude Code, receiving a delegated task from Codex. Codex will evaluate your report and may resume this session with feedback.',
    role,
    options.write ? 'Repository edits are authorized only for this task. Do not commit, push, publish, install dependencies, or contact others unless the task explicitly authorizes it.' : 'Read-only assignment. Do not edit files, run commands, or delegate to other agents.',
    options.allowBash ? 'Shell access is enabled for the task. It is not an operating-system sandbox; stay within the stated scope.' : 'Shell access is disabled. Report verification that requires commands as not run.',
    'Repository instruction files are not auto-loaded in this isolated launch. Read applicable AGENTS.md and CLAUDE.md with the Read tool before repository work. The coordinator should include any applicable parent instructions in the brief.',
    'Do not invoke other agents or nested delegation. Return a concise report of conclusions, changes, checks actually run, uncertainties, and any permission denials. If a permission denial prevents completion, say the task is incomplete. Distinguish evidence from inference.',
    options.kind !== 'rescue' ? 'Return structured findings using the required schema. Findings must cite repository-relative changed files and positive line numbers. Mark incomplete coverage or uncertainty explicitly; omitted binary content is not a verified review.' : '',
    'Output only the required structured report; do not add a second prose report, preamble, task recap, or routine progress narration. Keep the summary to 1–3 sentences. List each fact once in its appropriate field; use empty arrays when there is nothing to report. Include detail only when needed to act on a finding, verify a result, or explain a blocker.',
    'Use the required structured report. Completion describes your claim about the task, not independent verification. List uncertainties, checks not run and any unverified claims honestly.',
    options.reviewText || '',
    '\nTask brief:\n' + options.prompt,
  ].join('\n\n');
}


export function parseClaudeResult(processResult) {
  let response;
  try { response = JSON.parse(processResult.stdout); }
  catch {
    return { status: processResult.reason || 'failed', error: 'Claude did not return valid JSON.', rawOutput: processResult.stdout, stderr: processResult.stderr, exitCode: processResult.code };
  }
  if (!response || Array.isArray(response) || typeof response !== 'object') {
    return { status: processResult.reason || 'failed', error: 'Claude returned an invalid result envelope.', rawOutput: processResult.stdout, exitCode: processResult.code };
  }
  const denials = response.permission_denials || [];
  const complete = processResult.code === 0 && !response.is_error && response.subtype === 'success' && typeof response.result === 'string';
  return {
    status: processResult.reason || (!complete ? 'failed' : denials.length ? 'incomplete' : 'completed'),
    sessionId: response.session_id || null,
    result: response.result || '',
    structuredOutput: response.structured_output ?? null,
    processSuccess: processResult.code === 0 && !response.is_error && response.subtype === 'success',
    models: Object.keys(response.modelUsage || {}),
    usage: parseUsage(response),
    permissionDenials: denials,
    error: complete ? null : (response.errors || response.result || response.subtype || 'Claude run failed.'),
    exitCode: processResult.code,
    stderr: processResult.stderr,
  };
}


export function setup(binary = process.env.CLAUDE_CODE_BINARY || 'claude', cwd = process.cwd(), options = {}) {
  const chosen = selection(options);
  const compat = inspectCompatibility(binary, buildClaudeArgs({ kind: 'rescue', write: true, allowBash: true, sessionId: 'compat-probe', maxBudgetUsd: 1, model: chosen.model, effort: chosen.effort }), { cwd });
  const { failure, ...binaryInfo } = compat;
  if (failure?.kind === 'missing_cli' || !binaryInfo.path) return { available: false, error: failure?.message, binary: binaryInfo, modelAccessVerified: false };
  if (!binaryInfo.compatible) return { available: false, compatible: false, error: failure?.message, binary: binaryInfo, modelAccessVerified: false };
  const run = args => spawnSync(binaryInfo.path, args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  const auth = run(['auth', 'status']);
  let parsed = {};
  try { parsed = JSON.parse(auth.stdout); } catch {}
  return {
    available: true, version: binaryInfo.version, binary: binaryInfo, compatible: true, loggedIn: auth.status === 0 && parsed.loggedIn === true,
    authMethod: parsed.authMethod || 'unknown', provider: parsed.apiProvider || 'unknown',
    model: chosen.model, effort: chosen.effort ?? null, access: chosen.access, approvalMode: chosen.approvalMode, choices: selectionOptions(), modelAccessVerified: false,
    note: 'Setup checks the selected executable, option compatibility and local login only. A successful delegation verifies model access. Sandbox/keychain restrictions can make login appear unavailable.',
  };
}

const childGroups = new Map();
const stoppingGroups = new WeakMap();
function signalChild(child, signal) {
  // A live ChildProcess handle can be stopped directly even when ps is unavailable.
  // Persisted groups require both the boot id and leader start time to match.
  let group = stoppingGroups.get(child);
  if (!group && child.exitCode === null && child.signalCode === null) {
    group = childGroups.get(child.pid);
    if (group) stoppingGroups.set(child, group);
  }
  if (process.platform !== 'win32' && signalProcessGroup(group, signal)) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(signal); } catch (e) { if (!['ESRCH', 'EPERM'].includes(e.code)) throw e; }
  }
}
export function runProcess(binary, args, { cwd, input, timeoutMs, onStart, onLine, signal, maxBytes = 4 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', reason = null, error = null, bytes = 0, terminationDone = null;
    const killTimers = [];
    const stop = why => {
      if (reason) return;
      reason = why;
      if (!child.pid) return;
      signalChild(child, 'SIGINT');
      terminationDone = new Promise(done => {
        killTimers.push(setTimeout(() => signalChild(child, 'SIGTERM'), 1000));
        killTimers.push(setTimeout(() => { signalChild(child, 'SIGKILL'); done(); }, 2000));
      });
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed_out'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => {
      try { onStart?.(child.pid); if (signal?.aborted) abort(); }
      catch (e) { error = e.message; stop('state_error'); }
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) { stop('output_limit'); return; }
      if (!onLine) { stdout += data; return; }
      if (reason) return;
      pending += data;
      if (Buffer.byteLength(pending) > 1024 * 1024 && !pending.includes('\n')) { stop('output_limit'); return; }
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (Buffer.byteLength(line) > 1024 * 1024) { stop('output_limit'); return; }
        try { onLine(line); }
        catch (e) { error = e.message; stop('protocol_error'); return; }
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16_384); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('error', e => { cleanup(); reject(e); });
    child.once('close', async (code, exitSignal) => {
      // Escalation must also finish for descendants whose parent has already exited.
      if (terminationDone) await terminationDone;
      if (onLine && pending.trim() && !reason) {
        try { onLine(pending); } catch (e) { error = e.message; reason = 'protocol_error'; }
      }
      cleanup(); resolve({ code, exitSignal, stdout, stderr, reason, error });
    });
    function cleanup() {
      clearTimeout(timer); killTimers.forEach(clearTimeout);
      signal?.removeEventListener('abort', abort);
    }
  });
}

// Maps the observed outcome to the shared failure kinds. cancelled/interrupted/stale_parent belong to the lifecycle track.
function deriveFailure(job, output, envelope) {
  const code = output.code ?? null, signal = output.exitSignal ?? null;
  const detail = firstLine(sanitizeTail(output.stderr));
  const exited = code !== null ? `exited with code ${code}` : signal ? `was terminated by ${signal}` : 'exited';
  const message = (what, withDetail = true) => `${what}${withDetail && detail ? `: ${detail}` : ''}`;
  if (output.reason === 'timed_out') return { kind: 'timeout', message: 'Claude did not finish before the timeout.' };
  if (output.reason === 'cancelled' || job.status === 'cancelled') return null;
  if (output.reason === 'output_limit') return { kind: 'malformed_result', message: 'Claude output exceeded the size limit.' };
  if (output.reason === 'protocol_error') return { kind: 'malformed_result', message: firstLine(output.error) || 'Claude emitted malformed streaming output.' };
  if (output.reason) return { kind: 'no_result', message: firstLine(output.error) || `Claude run stopped: ${output.reason}.` };
  if (!envelope) {
    return (code !== 0)
      ? { kind: 'nonzero_exit', message: message(`Claude ${exited} without a final result`) }
      : { kind: 'no_result', message: 'Claude exited without a final result.' };
  }
  if (job.status === 'failed') {
    if (!job.processSuccess && code !== 0 && code !== null) return { kind: 'nonzero_exit', message: message(`Claude ${exited}`) };
    if (!job.processSuccess) return { kind: 'no_result', message: firstLine(String(job.error || 'Claude reported a failed run.')) };
    return { kind: 'malformed_result', message: firstLine(String(job.error || 'Claude result failed validation.')) };
  }
  if (job.status === 'incomplete' && job.permissionDenials?.length) return { kind: 'permission_denied', message: `${job.permissionDenials.length} tool permission denial(s).` };
  return null;
}

function addEvent(store, job, activity, persist = true) {
  const event = { ...activity, message: String(activity.message || '').slice(0, 512), sequence: (job.cursor || 0) + 1, at: new Date().toISOString() };
  observe(job.evidence, event);
  if(event.type === 'permission_denied') job.permissionDenials = [...(job.permissionDenials || []),{tool_name:event.tool}].slice(-100);
  job.cursor = event.sequence;
  job.events = [...(job.events || []), event].slice(-256);
  if (event.phase) job.phase = event.phase;
  job.lastActivityAt = event.at;
  if (persist) saveJob(store, job);
}

function prepare(options) {
  if (!options.prompt?.trim() && ['review','adversarial-review'].includes(options.kind)) options = {...options,prompt:options.kind==='review'?'Review the selected Git changes for actionable correctness issues.':'Challenge the selected Git changes, assumptions and concrete failure modes.'};
  if (!options.prompt?.trim()) throw new Error('A non-empty task brief is required.');
  selection(options); // Reject invalid explicit choices before creating state directories.
  const store = workspaceStore(options.cwd, options.stateDir);
  let previous;
  if (options.resume) {
    previous = reconcile(store, options.resume);
    if (!previous.sessionId) throw new Error('That job has no resumable Claude session.');
    if (active(previous) || previous.childMayBeRunning) throw new Error('That job is still running or requires orphan cleanup.');
    if (previous.kind !== options.kind) throw new Error('Resume requires the same command as the original job.');
    if (previous.ownerId && options.ownerId && previous.ownerId !== options.ownerId) throw new Error('The requested job belongs to another owner.');
  }
  const chosen = selection(options, previous);
  const request = {
    cwd: store.cwd, stateDir: store.root, kind: options.kind, prompt: options.prompt,
    ...chosen,
    timeoutMs: options.timeoutMs || 600_000, maxBudgetUsd: options.maxBudgetUsd,
    binary: options.binary || process.env.CLAUDE_CODE_BINARY || 'claude',
    sessionId: previous?.sessionId,
    scope: options.scope ?? previous?.reviewScope ?? 'auto', base: options.base ?? previous?.reviewBase ?? undefined,
  };
  const args = buildClaudeArgs(request); // Validate permissions before reserving a workspace or starting a process.
  // One compatibility gate before any lease or request file exists; request.binary becomes the probed absolute path.
  const binary = checkCompatibility(request.binary, args, { cwd: store.cwd });
  request.binary = binary.path;
  const job = {
    version: 2, id: randomUUID(), lockToken: randomUUID(), cwd: store.cwd, kind: request.kind,
    status: 'queued', phase: 'queued', model: request.model, effort: request.effort ?? null,
    write: request.write, allowBash: request.allowBash, access: request.access, approvalMode: request.approvalMode,
    reviewScope: request.kind === 'rescue' ? null : request.scope, reviewBase: request.base || null,
    ownerId: options.ownerId || previous?.ownerId || null,
    rootJobId: previous?.rootJobId || previous?.id || null,
    permissionChange: previous ? { from: { write: !!previous.write, allowBash: !!previous.allowBash }, to: { write: request.write, allowBash: request.allowBash } } : null,
    parentJobId: previous?.id || null, sessionId: previous?.sessionId || null,
    binary, createdAt: new Date().toISOString(), ownerPid: process.pid, bootId: bootIdentity(), cursor: 0, events: [],
  };
  job.rootJobId ||= job.id;
  acquireLock(store, job);
  try {
    if (previous) {
      // The workspace lease serializes head selection with publishing the next turn.
      const sessionJobs = listJobs(store).filter(candidate => candidate.sessionId === previous.sessionId && candidate.failure?.kind !== 'stale_parent');
      const parents = new Set(sessionJobs.map(candidate => candidate.parentJobId).filter(Boolean));
      const head = sessionJobs.find(candidate => !parents.has(candidate.id));
      if (head && head.id !== options.resume) {
        const message = `Cannot resume stale job ${options.resume}; current session head is ${head.id}. Select that exact job to continue.`;
        job.status = 'failed'; job.phase = 'failed'; job.finishedAt = new Date().toISOString();
        job.error = message; job.failure = { kind: 'stale_parent', message };
        saveJob(store, job);
        const error = new Error(message); error.failure = job.failure; error.jobId = job.id;
        throw error;
      }
    }
    saveJob(store, job); atomicJson(artifact(store, job.id, '.request.json'), request);
  }
  catch (e) { releaseLock(store, job); throw e; }
  return { store, job, request };
}

export async function runPrepared(store, job, request, onJob) {
  if (!ownsLock(store, job)) throw new Error('Worker no longer owns its workspace lock.');
  if (job.status !== 'queued') throw new Error('Job has already been claimed.');
  try { fs.mkdirSync(path.join(store.dir, 'active.lock', 'claimed'), { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Job has already been claimed.'); throw e; }
  job.status = 'running'; job.phase = 'starting'; job.workerPid = process.pid; job.startedAt = new Date().toISOString();
  job.workerHeartbeatAt = job.startedAt;
  job.evidence = startEvidence(request.cwd);
  saveJob(store, job);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGTERM', abort); process.on('SIGINT', abort);
  let scanning = false, lastScan = 0;
  const poll = setInterval(() => {
    try {
      if (!ownsLock(store, job)) { controller.abort(); return; }
      if (fs.existsSync(artifact(store, job.id, '.cancel'))) controller.abort();
      const now = Date.now();
      // Sampling misses a detached process whose parent exits within one interval; see the README.
      if (job.childPid && !scanning && now - lastScan >= 500) {
        scanning = true; lastScan = now;
        processTableAsync().then(rows => { if (recordDescendants(job, rows)) saveJob(store, job); }).catch(() => {}).finally(() => { scanning = false; });
      }
      if (now - Date.parse(job.workerHeartbeatAt) >= 1000) {
        job.workerHeartbeatAt = new Date(now).toISOString(); saveJob(store, job);
      }
    } catch { controller.abort(); }
  }, 100);
  let envelope = null;
  const collector = streamCollector({
    onActivity: event => addEvent(store, job, event),
    onSession(id, model) { job.sessionId = id; if (model) job.actualModel = model; saveJob(store, job); },
    onResult(value) { envelope = value; },
  });
  try {
    onJob?.(publicJob(job));
    if (fs.existsSync(artifact(store, job.id, '.cancel'))) { job.status = 'cancelled'; }
    else {
    if (request.kind !== 'rescue') {
      const review = collectReview(request.cwd, request);
      request.reviewText = review.text; job.reviewContext = review.metadata; saveJob(store, job);
    }
    addEvent(store, job, { type: 'worker_started', message: 'Worker started Claude.', phase: 'starting' });
    let output;
    try {
      output = await runProcess(request.binary, buildClaudeArgs(request), {
        cwd: request.cwd, input: buildPrompt(request), timeoutMs: request.timeoutMs, signal: controller.signal,
        maxBytes: 64 * 1024 * 1024, onLine: line => collector.line(line),
        onStart(pid) {
          job.childPid = pid;
          job.processGroup = processGroupIdentity(pid);
          job.childMayBeRunning = true;
          childGroups.set(pid, job.processGroup);
          if (childGroups.size > 256) childGroups.delete(childGroups.keys().next().value);
          saveJob(store, job);
        },
      });
    } catch (e) {
      job.process = { exitCode: null, signal: null, stderrTail: '', spawnError: sanitizeTail(e.message, 512) };
      job.failure = { kind: 'spawn', message: `Could not start Claude: ${firstLine(sanitizeTail(e.message, 512))}` };
      throw e;
    }
    // Record the true process outcome first: later validation may throw and must not lose it.
    job.process = { exitCode: output.code ?? null, signal: output.exitSignal ?? null, stderrTail: sanitizeTail(output.stderr), spawnError: null };
    job.exitCode = output.code ?? null; job.stderr = output.stderr;
    if (!output.reason) { try { envelope = collector.finish(); } catch { envelope = null; } }
    if (envelope) {
      const sessionId = job.sessionId;
      Object.assign(job, parseClaudeResult({ ...output, stdout: JSON.stringify(envelope) }));
      job.sessionId ||= sessionId;
      if (request.kind === 'rescue' && job.processSuccess && !output.reason) {
        validateSchema(job.structuredOutput, TASK_SCHEMA); job.contractValid=true;
        if(job.structuredOutput.completion === 'incomplete' || job.structuredOutput.checks.some(check=>check.outcome==='failed')) job.status='incomplete';
        job.result ||= job.structuredOutput.summary;
      }
      if (request.kind !== 'rescue' && job.exitCode === 0 && !output.reason && envelope.subtype === 'success') {
        job.review = validateReview(job.structuredOutput, job.reviewContext); job.contractValid=true;
        if (job.review.completion === 'incomplete' || job.reviewContext?.warnings.length) job.status = 'incomplete';
        job.result ||= job.review.summary;
      }
    } else {
      job.status = output.reason === 'protocol_error' || output.reason === 'state_error' ? 'failed' : output.reason || 'failed';
      job.error = output.error || 'Claude exited without a final result.';
    }
    if (output.error) job.error = output.error;
    if (['protocol_error', 'state_error'].includes(job.status)) job.status = 'failed';
    if (controller.signal.aborted && !output.reason) job.status = 'cancelled';
    if (job.status !== 'completed') job.failure ||= deriveFailure(job, output, envelope);
    }
  } catch (e) {
    job.status = 'failed'; job.error = e.message;
    job.failure ||= job.process ? { kind: 'malformed_result', message: firstLine(e.message) }
      : { kind: 'spawn', message: `Could not launch Claude: ${firstLine(e.message)}` };
  }
  finally {
    clearInterval(poll);
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
    if(job.evidence) job.evidence.counts.permissionDenied = Math.max(job.evidence.counts.permissionDenied,job.permissionDenials?.length || 0);
    try { if (job.childPid) { recordDescendants(job, processTable()); await stopTrackedSurvivors(job); } } catch {}
    finishEvidence(job,request.cwd);
    if (job.detachedProcesses?.length && job.evidence) {
      const left = job.detachedProcesses.filter(p => !p.stopped).length;
      job.evidence.warnings.push(left
        ? `${left} of ${job.detachedProcesses.length} background process(es) Claude started could not be stopped; the workspace stays locked until they exit.`
        : `${job.detachedProcesses.length} background process(es) Claude started were still running at job end and were stopped.`);
    }
    if(!job.write && job.status === 'completed' && job.evidence?.fileChanges.length) { job.status='incomplete'; job.evidence.partial=true; job.error='Workspace changed during a read-only job. Evaluate observed changes before accepting the report; attribution is not proven.'; }
    job.report = resultContract(job);
    job.finishedAt = new Date().toISOString(); job.phase = job.status;
    addEvent(store, job, { type: 'finished', message: `Job ${job.status}.`, phase: job.status }, false);
    // Publish terminal state only after cleanup: observers may immediately launch a successor.
    fs.rmSync(artifact(store, job.id, '.request.json'), { force: true });
    fs.rmSync(artifact(store, job.id, '.cancel'), { force: true });
    releaseLock(store, job);
    saveJob(store, job);
  }
  return publicJob(job);
}

export async function delegate(options) {
  const { store, job, request } = prepare(options);
  return runPrepared(store, job, request, options.onJob);
}
export async function launchBackground(options) {
  if (process.platform === 'win32') throw new Error('Background workers currently require macOS or Linux.');
  const { store, job } = prepare(options);
  const log = fs.openSync(artifact(store, job.id, '.worker.log'), 'a', 0o600);
  try {
    const cli = fileURLToPath(new URL('../bin/claude-companion.mjs', import.meta.url));
    const child = spawn(process.execPath, [cli, 'worker', '--cwd', store.cwd, '--state-dir', store.root, '--job', job.id, '--token', job.lockToken], {
      cwd: store.cwd, detached: true, stdio: ['ignore', 'ignore', log],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { id: job.id, status: 'queued', cwd: job.cwd, ownerId: job.ownerId, cursor: 0, model: job.model, effort: job.effort, access: job.access, approvalMode: job.approvalMode };
  } catch (e) {
    job.status = 'failed'; job.error = e.message; job.finishedAt = new Date().toISOString(); saveJob(store, job); releaseLock(store, job);
    fs.rmSync(artifact(store, job.id, '.request.json'), { force: true }); throw e;
  } finally { fs.closeSync(log); }
}
export async function runWorker(options) {
  const store = workspaceStore(options.cwd, options.stateDir);
  const job = readJob(store, options.id);
  if (job.lockToken !== options.token || !ownsLock(store, job)) throw new Error('Worker token or lease mismatch.');
  const request = JSON.parse(fs.readFileSync(artifact(store, job.id, '.request.json'), 'utf8'));
  return runPrepared(store, job, request);
}
export function cancelJob(store, id) {
  const job = reconcile(store, id);
  if (!active(job)) throw new Error('That job is not running.');
  if (!ownsLock(store, job)) throw new Error('Job does not own the active workspace lock.');
  // A control file is safer than signaling a persisted PID which could have been reused.
  fs.writeFileSync(artifact(store, id, '.cancel'), '', { mode: 0o600 });
  return { id, status: 'cancellation_requested', note: 'Wait for final status. Cancellation does not undo edits.' };
}
export async function statusJob(store, id, { after = 0, wait = false, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let job;
  while (true) {
    job = reconcile(store, id);
    if (!wait || !active(job) || (job.cursor || 0) > after || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  const events = (job.events || []).filter(e => e.sequence > after);
  const first = job.events?.[0]?.sequence || 1;
  const view = statusView(job);
  return { ...view, events, cursor: job.cursor || 0, eventsTruncated: after < first - 1, waitTimedOut: !!wait && active(job) && Date.now() >= deadline };
}
export function resultJob(store, id) {
  const job = reconcile(store, id);
  return { ...publicJob(job), report: job.report || resultContract(job), pending: active(job), partial: job.status !== 'completed' };
}

// Discovery is deliberately separate from selection: a caller must still pass an exact UUID.
export function resumeCandidates(store, ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    return { candidates: [], requiresExplicitJob: true, reason: 'Conversation identity is unavailable. Select an exact job UUID; no cross-chat candidates are inferred.' };
  }
  const jobs = listJobs(store, ownerId).map(job => reconcile(store, job.id)).filter(job => job.failure?.kind !== 'stale_parent');
  // One current head per Claude session, including running heads which suppress old turns.
  const heads = new Map();
  const parents = new Set(jobs.map(job => job.parentJobId).filter(Boolean));
  for (const job of jobs) {
    if (!job.sessionId || parents.has(job.id) || heads.has(job.sessionId)) continue;
    heads.set(job.sessionId, job);
  }
  const candidates = [...heads.values()]
    .filter(job => !active(job) && !job.childMayBeRunning)
    .map(job => ({
      id: job.id, parentJobId: job.parentJobId || null, rootJobId: job.rootJobId || job.id,
      ownerId: job.ownerId, kind: job.kind, status: job.status, sessionId: job.sessionId,
      model: job.model, effort: job.effort ?? null, access: capabilities({write:job.write,allowBash:job.allowBash}).access, approvalMode: job.approvalMode || 'preapproved-scope', write: !!job.write, allowBash: !!job.allowBash,
      createdAt: job.createdAt, finishedAt: job.finishedAt || null,
      requiresExplicitContinuation: true,
    }));
  return { candidates: candidates.slice(0, 20), truncated: candidates.length > 20, requiresExplicitJob: true };
}
