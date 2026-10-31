import test from 'node:test';
import assert from 'node:assert/strict';
import { streamCollector } from '../src/stream.mjs';

test('stream normalizer excludes thinking, raw tool content and unbounded tool names', () => {
  const events = []; let identity;
  const stream = streamCollector({ onActivity: event => events.push(event), onSession: id => { identity = id; } });
  const send = event => stream.line(JSON.stringify(event));
  send({ type: 'system', subtype: 'init', session_id: 'session-fixture' });
  send({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'must-not-persist' },
    { type: 'tool_use', id: 'a', name: 'x'.repeat(10000), input: { secret: 'must-not-persist' } },
  ] } });
  send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'must-not-persist', is_error: true }] } });
  send({ type: 'future_event', content: 'must-not-persist' });
  send({ type: 'result', subtype: 'success', result: 'Done.' });
  assert.equal(stream.finish().result, 'Done.'); assert.equal(identity, 'session-fixture');
  assert.ok(!JSON.stringify(events).includes('must-not-persist'));
  assert.equal(events[1].tool.length, 80); assert.equal(events[2].failed, true);
});
test('multiple final results and malformed events are protocol errors', () => {
  const stream = streamCollector({});
  assert.throws(() => stream.line('invalid'), /malformed/);
  stream.line('{"type":"result","result":"one"}');
  assert.throws(() => stream.line('{"type":"result","result":"two"}'), /more than one/);
});
