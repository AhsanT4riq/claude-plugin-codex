// Bounded, sanitized diagnostics and allowlisted usage numbers. Nothing here stores account or credential data.
const MAX_TAIL_BYTES = 4096;
const SECRET = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{8,}|\bAKIA[0-9A-Z]{12,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(authorization|api[_-]?key|token|secret|password|passwd)(\s*[:=]\s*)\S+/gi;

export function sanitizeTail(text, maxBytes = MAX_TAIL_BYTES) {
  if (typeof text !== 'string' || !text) return '';
  let clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\r\n?/g, '\n');
  clean = clean.replace(SECRET, (match, key, sep) => key ? `${key}${sep}[redacted]` : '[redacted]');
  let buffer = Buffer.from(clean.trim(), 'utf8');
  if (buffer.length > maxBytes) buffer = buffer.subarray(buffer.length - maxBytes);
  return buffer.toString('utf8').replace(/^�+/, '');
}

export function firstLine(text, limit = 200) {
  const line = String(text || '').split('\n').find(item => item.trim()) || '';
  return line.trim().slice(0, limit);
}

const count = value => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const money = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const sum = values => (values.some(value => value !== null) ? values.reduce((total, value) => total + (value ?? 0), 0) : null);
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;

// Allowlist: only the numeric fields below are read from the result envelope. A missing or invalid value is null.
export function parseUsage(envelope) {
  const totals = plain(envelope?.usage), models = plain(envelope?.modelUsage);
  if (!totals && !models && envelope?.total_cost_usd === undefined) return null;
  const byModel = {};
  for (const [name, raw] of Object.entries(models || {}).slice(0, 32)) {
    if (!MODEL_NAME.test(name)) continue;
    const item = plain(raw) || {};
    Object.defineProperty(byModel, name, { enumerable: true, configurable: true, writable: true, value: {
      inputTokens: count(item.inputTokens), outputTokens: count(item.outputTokens),
      cacheReadTokens: count(item.cacheReadInputTokens), cacheCreationTokens: count(item.cacheCreationInputTokens), costUsd: money(item.costUSD),
    } });
  }
  const perModel = key => sum(Object.values(byModel).map(item => item[key]));
  const pick = (reported, key) => reported ?? perModel(key);
  return {
    inputTokens: pick(count(totals?.input_tokens), 'inputTokens'),
    outputTokens: pick(count(totals?.output_tokens), 'outputTokens'),
    cacheReadTokens: pick(count(totals?.cache_read_input_tokens), 'cacheReadTokens'),
    cacheCreationTokens: pick(count(totals?.cache_creation_input_tokens), 'cacheCreationTokens'),
    costUsd: pick(money(envelope.total_cost_usd), 'costUsd'),
    byModel,
  };
}

export function usageLine(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const tokens = [];
  const add = (value, label) => { if (Number.isFinite(value)) tokens.push(`${value} ${label}`); };
  add(usage.inputTokens, 'in'); add(usage.outputTokens, 'out');
  add(usage.cacheReadTokens, 'cache read'); add(usage.cacheCreationTokens, 'cache write');
  const parts = [];
  if (tokens.length) parts.push(`tokens: ${tokens.join(', ')}`);
  if (Number.isFinite(usage.costUsd)) parts.push(`reported cost: $${usage.costUsd.toFixed(4)}`);
  if (!parts.length) return undefined;
  const models = Object.keys(usage.byModel || {}).length;
  return parts.join('; ') + (models > 1 ? ` (${models} models)` : '');
}
