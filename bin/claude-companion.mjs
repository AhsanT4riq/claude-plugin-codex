#!/usr/bin/env node
import fs from 'node:fs';
import { presentOutput } from '../src/output.mjs';
import { selectionOptions } from '../src/options.mjs';
import path from 'node:path';
import { delegate, launchBackground, runWorker, workspaceStore, listJobs, statusJob, resultJob, cancelJob, setup, resumeCandidates } from '../src/runtime.mjs';
import { statusView, reconcile } from '../src/state.mjs';

const HELP = `Claude Code companion
Commands: options, setup, rescue, review, adversarial-review, status, result, cancel
Task: --prompt TEXT | --prompt-file PATH | stdin
Options: --cwd PATH --model MODEL --effort LEVEL --resume JOB_UUID
         --access read-only|edit|shell --write --allow-bash --background | --wait --owner-id ID
         --timeout SECONDS --max-budget-usd USD --state-dir PATH
Reviews: --scope auto|working-tree|branch --base REF
Job controls: --job JOB_UUID
Output: compact JSON by default; --full includes complete diagnostics and evidence.
Continuation discovery: status --resume-candidates --owner-id ID
Progress: status --job ID --after CURSOR [--wait --timeout SECONDS]
Task timeout defaults to 600 seconds (max 3600); status wait defaults to 30 (max 60).
Effort: default|low|medium|high|xhigh|max (default: medium). Use options to list selection details.
Approval: selected tools approved upfront; further approval is denied, without interactive prompts.
Foreground is the default. Background jobs survive the launcher; no idle-chat wakeup.
`;
export function parseArgs(argv) {
  const known = new Set(['cwd', 'prompt', 'prompt-file', 'model', 'resume', 'effort', 'timeout', 'max-budget-usd', 'state-dir', 'job', 'after', 'owner-id', 'token', 'scope', 'base', 'access']);
  const flags = new Set(['write', 'allow-bash', 'background', 'wait', 'resume-candidates', 'full']);
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (argv[i] !== `--${key}` || (!known.has(key) && !flags.has(key))) throw new Error(`Unknown option: ${argv[i]}`);
    if (key in values) throw new Error(`Repeated option: --${key}`);
    if (flags.has(key)) values[key] = true;
    else {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
      values[key] = argv[++i];
    }
  }
  return values;
}
function seconds(value, fallback, maximum) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0 || n > maximum) throw new Error(`--timeout must be positive and at most ${maximum} seconds.`);
  return n * 1000;
}
async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || ['--help', 'help'].includes(command)) { console.log(HELP); return; }
  const v = parseArgs(argv);
  const common = ['cwd', 'state-dir'];
  const output = [...common, 'full'];
  const permitted = {
    options: [],
    setup: [...common, 'model', 'effort', 'access'],
    worker: [...common, 'job', 'token'],
    status: [...output, 'job', 'owner-id', 'after', 'wait', 'timeout', 'resume-candidates'],
    result: [...output, 'job'], cancel: [...output, 'job'],
  };
  const taskOptions = [...output, 'prompt', 'prompt-file', 'model', 'resume', 'effort', 'timeout', 'max-budget-usd', 'write', 'allow-bash', 'background', 'wait', 'owner-id', 'access'];
  if (['review', 'adversarial-review'].includes(command)) taskOptions.push('scope', 'base');
  const allowed = permitted[command] || (['rescue', 'review', 'adversarial-review'].includes(command) ? taskOptions : []);
  for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error(`Option --${key} is not supported by ${command}.`);
  if (v.background && v.wait) throw new Error('Choose --background or --wait.');
  if (command !== 'worker' && v.token) throw new Error('--token is internal.');
  const cwd = path.resolve(v.cwd || process.cwd());
  let result;
  if (command === 'options') {
    result = selectionOptions();
  } else if (command === 'worker') {
    result = await runWorker({ cwd, stateDir: v['state-dir'], id: v.job, token: v.token });
    if (result.status !== 'completed') process.exitCode = 1;
    return;
  } else if (command === 'setup') {
    result = setup(undefined, cwd, { model: v.model, effort: v.effort, access: v.access });
    if (!result.available || !result.loggedIn) process.exitCode = 1;
  } else if (['status', 'result', 'cancel'].includes(command)) {
    const store = workspaceStore(cwd, v['state-dir']);
    const after = Number(v.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('--after must be a nonnegative integer.');
    if (command === 'status') {
      if (v['resume-candidates'] && (v.job || v.wait || v.after !== undefined || v.timeout !== undefined)) throw new Error('--resume-candidates cannot be combined with job/progress options.');
      if (!v.job && (v.wait || v.after !== undefined)) throw new Error('Waiting or incremental status requires --job.');
      result = v['resume-candidates'] ? resumeCandidates(store, v['owner-id']) : v.job ? await statusJob(store, v.job, { after, wait: !!v.wait, timeoutMs: seconds(v.timeout, 30, 60) })
        : listJobs(store, v['owner-id']).slice(0, 20).map(job => statusView(reconcile(store, job.id)));
    } else if (command === 'result') result = resultJob(store, v.job);
    else result = cancelJob(store, v.job);
  } else if (['rescue', 'review', 'adversarial-review'].includes(command)) {
    if (v.prompt !== undefined && v['prompt-file'] !== undefined) throw new Error('Choose --prompt or --prompt-file.');
    const prompt = v.prompt ?? (v['prompt-file'] ? fs.readFileSync(v['prompt-file'], 'utf8') : process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'));
    const budget = v['max-budget-usd'] === undefined ? undefined : Number(v['max-budget-usd']);
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) throw new Error('--max-budget-usd must be positive.');
    const options = {
      kind: command, cwd, prompt, access: v.access, model: v.model, resume: v.resume, effort: v.effort,
      scope: v.scope, base: v.base,
      write: v.write, allowBash: v['allow-bash'], ownerId: v['owner-id'],
      timeoutMs: seconds(v.timeout, 600, 3600), maxBudgetUsd: budget, stateDir: v['state-dir'],
      onJob(job) { console.error(JSON.stringify({ id: job.id, status: job.status, cwd: job.cwd, model: job.model, effort: job.effort, access: job.access, approvalMode: job.approvalMode })); },
    };
    result = await (v.background ? launchBackground(options) : delegate(options));
    if (!v.background && result.status !== 'completed') process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(presentOutput(command, result, { full: !!v.full }), null, v.full ? 2 : undefined));
}
main().catch(e => { console.error(JSON.stringify({ error: e.message, ...(e.failure ? { failure: e.failure } : {}) })); process.exitCode = 1; });
