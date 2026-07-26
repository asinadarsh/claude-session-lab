import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicErrorBody,
  createResultCollector,
  errorTypeForStatus,
  parseMessagesRequest,
  resolveModel,
  sseChunk,
  streamEventsFor,
} from '../src/messages.mjs';

const LIMITS = { maxPromptChars: 2000, maxImages: 2, maxImageBytes: 100, maxMessages: 10 };
const PNG_B64 = Buffer.from('tiny-png-bytes').toString('base64');

function imageBlock(overrides = {}) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG_B64, ...overrides },
  };
}

test('resolveModel accepts aliases and dated ids, rejects hostile input', () => {
  assert.equal(resolveModel(undefined), 'sonnet');
  assert.equal(resolveModel(''), 'sonnet');
  assert.equal(resolveModel('sonnet'), 'sonnet');
  assert.equal(resolveModel('opus'), 'opus');
  assert.equal(resolveModel('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5-20250929');
  for (const bad of ['sonnet; rm -rf /', '../../etc/passwd', 'claude-' + 'x'.repeat(70), 'claude sonnet', 42]) {
    assert.throws(() => resolveModel(bad), (error) => error.code === 'MODEL_INVALID');
  }
});

test('multi-turn flattening builds one JSONL user line with transcript before the final question', () => {
  const parsed = parseMessagesRequest({
    model: 'sonnet',
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: 'final question' },
    ],
  }, LIMITS);
  assert.equal(parsed.cliInputLine.includes('\n'), false);
  const line = JSON.parse(parsed.cliInputLine);
  assert.equal(line.type, 'user');
  assert.equal(line.message.role, 'user');
  assert.equal(line.message.content.length, 1);
  const text = line.message.content[0].text;
  assert.match(text, /Human: first question/);
  assert.match(text, /Assistant: first answer/);
  assert.ok(text.indexOf('Human: first question') < text.indexOf('Assistant: first answer'));
  assert.ok(text.indexOf('Assistant: first answer') < text.indexOf('final question'));
  assert.ok(text.endsWith('final question'));
  assert.ok(parsed.historyChars > 0);
  assert.equal(parsed.stream, false);
  assert.equal(parsed.maxTokens, 4096);
  assert.equal(parsed.includeThinking, false);
});

test('single-turn request has no transcript preamble', () => {
  const parsed = parseMessagesRequest({ messages: [{ role: 'user', content: 'hi' }] }, LIMITS);
  const line = JSON.parse(parsed.cliInputLine);
  assert.equal(line.message.content[0].text, 'hi');
  assert.equal(parsed.historyChars, 0);
  assert.equal(parsed.model, 'sonnet');
});

test('assistant-last, empty, unknown-role, and oversized message lists are rejected', () => {
  const isInvalid = (error) => error.code === 'MESSAGES_INVALID';
  assert.throws(() => parseMessagesRequest({ messages: [] }, LIMITS), isInvalid);
  assert.throws(() => parseMessagesRequest({ messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ] }, LIMITS), isInvalid);
  assert.throws(() => parseMessagesRequest({ messages: [{ role: 'system', content: 'x' }] }, LIMITS), isInvalid);
  const tooMany = Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }));
  assert.throws(() => parseMessagesRequest({ messages: tooMany }, LIMITS), isInvalid);
});

test('tool_use and tool_result blocks are rejected', () => {
  const isToolError = (error) => error.code === 'TOOL_USE_UNSUPPORTED';
  assert.throws(() => parseMessagesRequest({ messages: [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
  ] }, LIMITS), isToolError);
  assert.throws(() => parseMessagesRequest({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
    { role: 'user', content: 'next' },
  ] }, LIMITS), isToolError);
});

test('system flattens from string and from block array', () => {
  const fromString = parseMessagesRequest({
    system: 'Be terse.',
    messages: [{ role: 'user', content: 'hi' }],
  }, LIMITS);
  assert.equal(fromString.systemPrompt, 'Be terse.');
  const fromBlocks = parseMessagesRequest({
    system: [{ type: 'text', text: 'Be terse.' }, { type: 'text', text: 'Be kind.' }],
    messages: [{ role: 'user', content: 'hi' }],
  }, LIMITS);
  assert.equal(fromBlocks.systemPrompt, 'Be terse.\n\nBe kind.');
  const absent = parseMessagesRequest({ messages: [{ role: 'user', content: 'hi' }] }, LIMITS);
  assert.equal(absent.systemPrompt, null);
  assert.throws(() => parseMessagesRequest({
    system: [{ type: 'image' }],
    messages: [{ role: 'user', content: 'hi' }],
  }, LIMITS), (error) => error.code === 'SYSTEM_INVALID');
});

test('oversized flattened prompt throws PROMPT_TOO_LARGE with status 413', () => {
  assert.throws(
    () => parseMessagesRequest({ messages: [{ role: 'user', content: 'x'.repeat(2001) }] }, LIMITS),
    (error) => error.code === 'PROMPT_TOO_LARGE' && error.status === 413,
  );
});

test('max_tokens clamps into [256, 64000] and defaults to 4096', () => {
  const base = { messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(parseMessagesRequest({ ...base, max_tokens: 1 }, LIMITS).maxTokens, 256);
  assert.equal(parseMessagesRequest({ ...base, max_tokens: 999999 }, LIMITS).maxTokens, 64000);
  assert.equal(parseMessagesRequest({ ...base, max_tokens: 1000 }, LIMITS).maxTokens, 1000);
  assert.equal(parseMessagesRequest({ ...base, max_tokens: 'nope' }, LIMITS).maxTokens, 4096);
});

test('stream, thinking, and stop_sequences parse', () => {
  const parsed = parseMessagesRequest({
    stream: true,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    stop_sequences: ['END', 'STOP'],
    messages: [{ role: 'user', content: 'hi' }],
  }, LIMITS);
  assert.equal(parsed.stream, true);
  assert.equal(parsed.includeThinking, true);
  assert.deepEqual(parsed.stopSequences, ['END', 'STOP']);
  assert.throws(() => parseMessagesRequest({
    stop_sequences: ['a', 'b', 'c', 'd', 'e'],
    messages: [{ role: 'user', content: 'hi' }],
  }, LIMITS), (error) => error.code === 'STOP_SEQUENCES_INVALID');
});

test('image happy path puts the image block before the text block', () => {
  const parsed = parseMessagesRequest({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'what is this?' },
      imageBlock(),
    ] }],
  }, LIMITS);
  const content = JSON.parse(parsed.cliInputLine).message.content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(content[0].source.data, PNG_B64);
  assert.equal(content[1].type, 'text');
  assert.equal(content[1].text, 'what is this?');
});

test('invalid images are rejected: media type, base64, size, url source, count', () => {
  const request = (block) => ({ messages: [{ role: 'user', content: [block, { type: 'text', text: 'q' }] }] });
  assert.throws(
    () => parseMessagesRequest(request(imageBlock({ media_type: 'image/tiff' })), LIMITS),
    (error) => error.code === 'IMAGE_MEDIA_TYPE_INVALID',
  );
  assert.throws(
    () => parseMessagesRequest(request(imageBlock({ data: 'not base64!!!' })), LIMITS),
    (error) => error.code === 'IMAGE_BASE64_INVALID',
  );
  const oversized = Buffer.alloc(101).toString('base64');
  assert.throws(
    () => parseMessagesRequest(request(imageBlock({ data: oversized })), LIMITS),
    (error) => error.code === 'IMAGE_TOO_LARGE' && error.status === 413,
  );
  assert.throws(
    () => parseMessagesRequest(request({ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } }), LIMITS),
    (error) => error.code === 'IMAGE_URL_UNSUPPORTED',
  );
  assert.throws(() => parseMessagesRequest({
    messages: [{ role: 'user', content: [imageBlock(), imageBlock(), imageBlock(), { type: 'text', text: 'q' }] }],
  }, LIMITS), (error) => error.code === 'TOO_MANY_IMAGES');
});

test('images in non-final messages become an [image omitted] marker', () => {
  const parsed = parseMessagesRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, imageBlock()] },
      { role: 'assistant', content: 'nice' },
      { role: 'user', content: 'final' },
    ],
  }, LIMITS);
  const content = JSON.parse(parsed.cliInputLine).message.content;
  assert.equal(content.length, 1);
  assert.match(content[0].text, /\[image omitted\]/);
});

test('collector builds a well-formed Message and drops thinking blocks by default', () => {
  const collector = createResultCollector({ includeThinking: false });
  collector.push({ type: 'system', subtype: 'init' });
  collector.push({ type: 'unexpected' });
  collector.push(null);
  collector.push({ type: 'assistant', message: {
    model: 'claude-sonnet-4-5-20250929',
    content: [{ type: 'thinking', thinking: 'pondering' }, { type: 'text', text: 'the answer' }],
  } });
  collector.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  collector.push({ type: 'result', is_error: false, subtype: 'success', result: 'the answer',
    stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 34 } });
  assert.deepEqual(collector.rateLimit, { status: 'allowed' });
  assert.equal(collector.result.subtype, 'success');
  const message = collector.toMessage({ requestId: 'req1' });
  assert.equal(message.id, 'msg_req1');
  assert.equal(message.type, 'message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.model, 'claude-sonnet-4-5-20250929');
  assert.deepEqual(message.content, [{ type: 'text', text: 'the answer' }]);
  assert.equal(message.stop_reason, 'end_turn');
  assert.equal(message.stop_sequence, null);
  assert.deepEqual(message.usage, {
    input_tokens: 12,
    output_tokens: 34,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test('collector keeps thinking blocks when includeThinking', () => {
  const collector = createResultCollector({ includeThinking: true });
  collector.push({ type: 'assistant', message: {
    content: [{ type: 'thinking', thinking: 'pondering' }, { type: 'text', text: 'the answer' }],
  } });
  const message = collector.toMessage({ requestId: 'req2' });
  assert.equal(message.content.length, 2);
  assert.equal(message.content[0].type, 'thinking');
});

test('collector falls back to result.result text and maps stop_reason', () => {
  const collector = createResultCollector({ includeThinking: false, model: 'sonnet' });
  collector.push({ type: 'result', result: 'fallback text', stop_reason: 'stop_sequence', usage: {} });
  const message = collector.toMessage({});
  assert.deepEqual(message.content, [{ type: 'text', text: 'fallback text' }]);
  assert.equal(message.stop_reason, 'stop_sequence');
  assert.equal(message.model, 'sonnet');
  assert.deepEqual(Object.values(message.usage), [0, 0, 0, 0]);
  assert.match(message.id, /^msg_/);

  const weird = createResultCollector({ includeThinking: false });
  weird.push({ type: 'result', result: 'x', stop_reason: 'something_new' });
  assert.equal(weird.toMessage({}).stop_reason, 'end_turn');
  const truncated = createResultCollector({ includeThinking: false });
  truncated.push({ type: 'result', result: 'x', stop_reason: 'max_tokens' });
  assert.equal(truncated.toMessage({}).stop_reason, 'max_tokens');
});

test('streamEventsFor re-indexes blocks after suppressing a leading thinking block', () => {
  const state = {};
  const opts = { includeThinking: false };
  const wrap = (event) => ({ type: 'stream_event', event });
  assert.deepEqual(streamEventsFor(wrap({
    type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' },
  }), state, opts), []);
  assert.deepEqual(streamEventsFor(wrap({
    type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' },
  }), state, opts), []);
  assert.deepEqual(streamEventsFor(wrap({ type: 'content_block_stop', index: 0 }), state, opts), []);
  const start = streamEventsFor(wrap({
    type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' },
  }), state, opts);
  assert.equal(start.length, 1);
  assert.equal(start[0].event, 'content_block_start');
  assert.equal(start[0].data.index, 0);
  const delta = streamEventsFor(wrap({
    type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' },
  }), state, opts);
  assert.equal(delta[0].data.index, 0);
  assert.equal(delta[0].data.delta.text, 'hi');
  const stop = streamEventsFor(wrap({ type: 'content_block_stop', index: 1 }), state, opts);
  assert.equal(stop[0].data.index, 0);
});

test('streamEventsFor passes thinking through when includeThinking and ignores non-stream lines', () => {
  const events = streamEventsFor({ type: 'stream_event', event: {
    type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' },
  } }, {}, { includeThinking: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.index, 0);
  for (const junk of [null, 42, {}, { type: 'result' }, { type: 'assistant' },
    { type: 'stream_event' }, { type: 'stream_event', event: 'oops' }]) {
    assert.deepEqual(streamEventsFor(junk, {}, { includeThinking: false }), []);
  }
});

test('sseChunk emits the exact wire format', () => {
  assert.equal(sseChunk('ping', { ok: true }), 'event: ping\ndata: {"ok":true}\n\n');
});

test('anthropic error helpers use real error type strings', () => {
  assert.deepEqual(anthropicErrorBody('rate_limit_error', 'Slow down.'), {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Slow down.' },
  });
  assert.equal(anthropicErrorBody('made_up_error', 'x').error.type, 'api_error');
  assert.equal(errorTypeForStatus(400), 'invalid_request_error');
  assert.equal(errorTypeForStatus(401), 'authentication_error');
  assert.equal(errorTypeForStatus(403), 'permission_error');
  assert.equal(errorTypeForStatus(404), 'not_found_error');
  assert.equal(errorTypeForStatus(413), 'request_too_large');
  assert.equal(errorTypeForStatus(429), 'rate_limit_error');
  assert.equal(errorTypeForStatus(529), 'overloaded_error');
  assert.equal(errorTypeForStatus(502), 'api_error');
  assert.equal(errorTypeForStatus(418), 'invalid_request_error');
});
