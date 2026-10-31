#!/usr/bin/env node
// Failure-mode fixture for the diagnostics track. Mode is chosen by the prompt's final token,
// except FAKE_CLAUDE_OLD=1 which emulates an old CLI that rejects newer flags.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(process.env.FAKE_CLAUDE_VERSION || '2.1.292 (failure fixture)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const rejected = new Set((process.env.FAKE_CLAUDE_REJECT || (process.env.FAKE_CLAUDE_OLD ? '--safe-mode' : '')).split(',').filter(Boolean));
for (const arg of args) {
  if (rejected.has(arg)) { console.error(`error: unknown option '${arg}'`); process.exit(1); }
}
if (args.includes('--bridge-compat-probe')) { console.error("error: unknown option '--bridge-compat-probe'"); process.exit(1); }
const prompt = fs.readFileSync(0, 'utf8');
const send = data => console.log(JSON.stringify(data));
const sessionId = randomUUID();
send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5' });
if (prompt.endsWith('EXIT2')) {
  process.stderr.write('DISTINCTIVE_STDERR_DIAGNOSTIC: backend unavailable api_key=sk-ant-api03-SECRETSECRET token=abcdef123456\n', () => process.exit(2));
  await new Promise(() => {});
}
if (prompt.endsWith('NO_RESULT')) process.exit(0);
if (prompt.endsWith('INVALID_JSON')) { console.log('{not json'); process.exit(0); }
if (prompt.endsWith('INTERRUPTED')) {
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.txt' } }] } });
  await new Promise(done => process.stderr.write('stream cut short\n', done));
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
}
const result = extra => send({
  type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'ok',
  structured_output: { summary: 'Fixture task', completion: 'completed', changes: [], checks: [], uncertainties: [], unverifiedClaims: [] },
  permission_denials: [], ...extra,
});
if (prompt.endsWith('ERROR_ENVELOPE')) {
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: '', errors: ['overloaded'] });
  process.stderr.write('model overloaded\n', () => process.exit(1));
  await new Promise(() => {});
}
if (prompt.endsWith('USAGE')) {
  result({
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100, service_tier: 'secret-tier' },
    total_cost_usd: 0.0123, account: { email: 'must-not-be-stored@example.invalid' },
    modelUsage: {
      'claude-opus-5-5': { inputTokens: 1000, outputTokens: 300, cacheReadInputTokens: 4000, cacheCreationInputTokens: 100, costUSD: 0.01, contextWindow: 200000 },
      'claude-haiku-5-5': { inputTokens: 200, outputTokens: 40, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0, costUSD: 0.0023 },
    },
  });
} else result();
