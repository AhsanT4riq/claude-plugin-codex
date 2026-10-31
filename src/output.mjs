import { usageLine } from './diagnostics.mjs';
// Presentation only: persisted jobs and programmatic runtime results remain complete.
// Whitelists prevent future internal job fields from leaking into routine output.
const fields = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const jobKeys = ['id', 'kind', 'status', 'model', 'effort', 'access', 'approvalMode', 'parentJobId', 'phase', 'pending', 'partial', 'cursor', 'error', 'failure', 'note', 'childMayBeRunning'];
const evidenceView = evidence => evidence && fields(evidence, ['counts', 'partial', 'actionsTruncated', 'warnings', 'root', 'coverage', 'attribution']);
// Event history is progress, not a result: only cursor-based status responses carry it.
export function compactJob(job, { events = true } = {}) {
  if (!job || typeof job !== 'object') return job;
  const view = fields(job, jobKeys);
  const usage = usageLine(job.usage);
  if (usage) view.usage = usage;
  if (job.process) view.process = fields(job.process, ['exitCode', 'signal', 'spawnError']);
  const report = job.report;
  if (report) {
    view.report = fields(report, ['version', 'process', 'task', 'claims', 'permissionDenials']);
    const observed = evidenceView(report.observed);
    if (observed) {
      observed.fileChanges = (report.observed.fileChanges || []).map(change => fields(change, ['file', 'change']));
      view.report.observed = observed;
    }
    // Uncertainties/unverifiedClaims are already present in claims. Keep only extras.
    const claimed = new Set(report.claims?.uncertainties || []);
    const warnings = new Set(report.observed?.warnings || []);
    const extra = (report.uncertainties || []).filter(item => !claimed.has(item) && !warnings.has(item) && item !== job.error);
    if (extra.length) view.report.uncertainties = [...new Set(extra)];
    if (!report.claims && report.unverifiedClaims?.length) view.report.unverifiedClaims = report.unverifiedClaims;
    if (report.selection?.actualModels?.length) view.actualModels = report.selection.actualModels;
  } else if (job.summary) view.summary = job.summary;
  if (!report?.claims && job.result) view.result = job.result;
  if (job.reviewContext) view.reviewContext = fields(job.reviewContext, ['scope', 'root', 'base', 'warnings']);
  if (events && job.events) {
    view.events = job.events.map(event => fields(event, ['sequence', 'type', 'phase', 'tool', 'failed']));
    Object.assign(view, fields(job, ['eventsTruncated', 'waitTimedOut']));
  }
  return view;
}
export function presentOutput(command, value, { full = false } = {}) {
  if (full || !['rescue', 'review', 'adversarial-review', 'status', 'result', 'cancel'].includes(command)) return value;
  const options = { events: command === 'status' };
  if (Array.isArray(value)) return value.map(item => compactJob(item, options));
  // Continuation discovery is already a bounded, purpose-built response.
  if (value?.candidates) return value;
  return compactJob(value, options);
}
