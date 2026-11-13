'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { streamChat } = require('../lib/providers');

test('Anthropic continuation adds rounds but merges cumulative message_delta output', async t => {
  let round = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    round++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = x => res.write(`data: ${JSON.stringify(x)}\n\n`);
    event({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 0 } } });
    event({ type: 'message_delta', usage: { output_tokens: 3 } });
    event({ type: 'message_delta', delta: { stop_reason: round === 1 ? 'pause_turn' : 'end_turn' }, usage: { output_tokens: 7 } });
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  let seen;
  const result = await streamChat({ provider: { type: 'anthropic', baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: 'fake' }, model: 'test', messages: [{ role: 'user', text: 'hello', images: [] }], effort: 'off', emit: ev => { if (ev.type === 'usage') seen = ev.usage; } });
  assert.equal(round, 2);
  assert.deepEqual(result.usage, { input_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 14 });
  assert.deepEqual(seen, result.usage);
});
