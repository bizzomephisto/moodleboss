const assert = require('node:assert/strict');
const { test } = require('node:test');
const { complete } = require('../src/ai-provider.cjs');

const messages = [{ role: 'system', content: 'Assist instructors.' }, { role: 'user', content: 'Help plan a lesson.' }];
const first = 'Sketch a café';
const second = ' chair.';
const cases = [
  ['openai', '/responses', [
    { type: 'response.output_text.delta', delta: first },
    { type: 'response.output_text.delta', delta: second },
    { type: 'response.completed' },
  ]],
  ['gemini', '/models/fixture:streamGenerateContent?alt=sse', [
    { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: first }] } }] },
    { candidates: [{ content: { parts: [{ text: second }] }, finishReason: 'STOP' }] },
  ]],
  ['claude', '/messages', [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: first } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: second } },
    { type: 'message_stop' },
  ]],
  ['lmstudio', '/chat/completions', [
    { choices: [{ delta: { content: first } }] },
    { choices: [{ delta: { content: second }, finish_reason: 'stop' }] },
  ]],
];

test('Chat receives visible text incrementally for every provider format', async t => {
  for (const [provider, route, events] of cases) {
    await t.test(provider, async t => {
      let send;
      let releaseFirstText;
      const receivedFirstText = new Promise(resolve => { releaseFirstText = resolve; });
      t.mock.method(global, 'fetch', async (url, options) => {
        assert.equal(url, 'https://model.test/v1' + route);
        if (provider !== 'gemini') assert.equal(JSON.parse(options.body).stream, true);
        return new Response(new ReadableStream({ start: controller => { send = controller; } }),
          { headers: { 'Content-Type': 'text/event-stream' } });
      });
      const deltas = [];
      const reply = complete({ provider, endpoint: 'https://model.test/v1', model: 'fixture' },
        'fixture-key', messages, undefined, undefined, delta => {
          deltas.push(delta);
          releaseFirstText();
        });
      const frame = event => Buffer.from('data: ' + JSON.stringify(event) + '\r\n\r\n');
      const bytes = frame(events[0]);
      const split = bytes.indexOf(Buffer.from('é')) + 1;
      send.enqueue(bytes.subarray(0, split));
      send.enqueue(bytes.subarray(split, -1));
      send.enqueue(bytes.subarray(-1));
      await receivedFirstText;
      assert.deepEqual(deltas, [first]);
      for (const event of events.slice(1)) send.enqueue(frame(event));
      send.close();
      assert.equal(await reply, first + second);
      assert.deepEqual(deltas, [first, second]);
    });
  }
});

test('Chat can use a buffered reply and detects an interrupted stream', async t => {
  const settings = { provider: 'compatible', endpoint: 'https://model.test/v1', model: 'fixture' };
  const fixture = t.mock.method(global, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: 'Buffered reply' } }] }));
  assert.equal(await complete(settings, '', messages, undefined, undefined, () => {}), 'Buffered reply');
  fixture.mock.mockImplementation(async () => new Response(
    'data: {"choices":[{"delta":{"content":"Partial reply"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  const deltas = [];
  await assert.rejects(complete(settings, '', messages, undefined, undefined, delta => deltas.push(delta)), /interrupted/);
  assert.deepEqual(deltas, ['Partial reply']);
});
