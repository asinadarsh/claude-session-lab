import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreamAdapter,
  fromAnthropicMessage,
  modelsList,
  openaiErrorBody,
  toAnthropicBody,
} from '../src/openai.mjs';

const user = (content) => ({ role: 'user', content });

test('system messages anywhere are hoisted into anthropic system, order preserved', () => {
  const body = toAnthropicBody({
    model: 'claude-x',
    messages: [
      user('Hi'),
      { role: 'system', content: 'First rule.' },
      { role: 'assistant', content: 'Hello' },
      { role: 'system', content: [{ type: 'text', text: 'Second rule.' }] },
      user('Bye'),
    ],
  });
  assert.equal(body.model, 'claude-x');
  assert.equal(body.system, 'First rule.\n\nSecond rule.');
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: 'Bye' },
  ]);
});

test('data-url image parts become base64 image blocks', () => {
  const body = toAnthropicBody({
    model: 'claude-x',
    messages: [user([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ])],
  });
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'What is this?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ]);
});

test('remote image urls are rejected', () => {
  assert.throws(
    () => toAnthropicBody({
      model: 'claude-x',
      messages: [user([{ type: 'image_url', image_url: { url: 'https://example.test/cat.png' } }])],
    }),
    (error) => error.code === 'IMAGE_URL_UNSUPPORTED' && error.status === 400,
  );
});

test('tool use in any form is rejected, but tools: [] is harmless', () => {
  const messages = [user('Hi')];
  const rejects = (body) => assert.throws(
    () => toAnthropicBody(body),
    (error) => error.code === 'TOOL_USE_UNSUPPORTED' && error.status === 400,
  );
  rejects({ model: 'claude-x', messages, tools: [{ type: 'function' }] });
  rejects({ model: 'claude-x', messages, functions: [{ name: 'f' }] });
  rejects({ model: 'claude-x', messages, tool_choice: 'auto' });
  rejects({ model: 'claude-x', messages: [...messages, { role: 'tool', content: 'x' }] });
  rejects({ model: 'claude-x', messages: [...messages, { role: 'function', content: 'x' }] });
  assert.deepEqual(toAnthropicBody({ model: 'claude-x', messages, tools: [] }).messages, messages);
});

test('n>1 is rejected while sampling knobs are silently ignored', () => {
  const base = { model: 'claude-x', messages: [user('Hi')] };
  assert.throws(
    () => toAnthropicBody({ ...base, n: 2 }),
    (error) => error.code === 'N_UNSUPPORTED' && error.status === 400,
  );
  const body = toAnthropicBody({
    ...base,
    n: 1,
    temperature: 0.2,
    top_p: 0.9,
    presence_penalty: 1,
    seed: 7,
    logprobs: true,
    response_format: { type: 'json_object' },
  });
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model']);
});

test('max_completion_tokens, stream and stop map onto anthropic fields', () => {
  const body = toAnthropicBody({
    model: 'claude-x',
    messages: [user('Hi')],
    max_completion_tokens: 512,
    stream: true,
    stop: 'END',
  });
  assert.equal(body.max_tokens, 512);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stop_sequences, ['END']);
  const other = toAnthropicBody({ model: 'claude-x', messages: [user('Hi')], max_tokens: 64, stop: ['a', 'b'] });
  assert.equal(other.max_tokens, 64);
  assert.deepEqual(other.stop_sequences, ['a', 'b']);
});

test('empty or non-array messages are rejected', () => {
  for (const messages of [[], null, undefined, 'hi', {}]) {
    assert.throws(
      () => toAnthropicBody({ model: 'claude-x', messages }),
      (error) => error.code === 'MESSAGES_INVALID' && error.status === 400,
    );
  }
});

test('fromAnthropicMessage builds a chat.completion and skips thinking blocks', () => {
  const message = {
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  };
  const response = fromAnthropicMessage(message, { model: 'claude-x', id: 'abc', created: 1234 });
  assert.equal(response.id, 'chatcmpl-abc');
  assert.equal(response.object, 'chat.completion');
  assert.equal(response.created, 1234);
  assert.equal(response.model, 'claude-x');
  assert.deepEqual(response.choices, [
    { index: 0, message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' },
  ]);
  assert.deepEqual(response.usage, { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 });
  const defaults = fromAnthropicMessage({ content: [], stop_reason: 'end_turn', usage: {} }, { model: 'm' });
  assert.match(defaults.id, /^chatcmpl-[A-Za-z0-9_-]+$/);
  assert.equal(Number.isInteger(defaults.created), true);
});

test('finish_reason mapping covers all four anthropic stop reasons', () => {
  const reason = (stop) => fromAnthropicMessage({ content: [], stop_reason: stop, usage: {} }, { model: 'm' })
    .choices[0].finish_reason;
  assert.equal(reason('end_turn'), 'stop');
  assert.equal(reason('max_tokens'), 'length');
  assert.equal(reason('stop_sequence'), 'stop');
  assert.equal(reason('tool_use'), 'tool_calls');
});

test('stream adapter emits first/middle/last chunks with stable identity', () => {
  const adapter = createStreamAdapter({ id: 'abc', model: 'claude-x', created: 1234 });
  const first = adapter.first();
  const middle = adapter.delta('Hel');
  const last = adapter.last('max_tokens');
  for (const chunk of [first, middle, last]) {
    assert.equal(chunk.id, 'chatcmpl-abc');
    assert.equal(chunk.object, 'chat.completion.chunk');
    assert.equal(chunk.created, 1234);
    assert.equal(chunk.model, 'claude-x');
    assert.equal(chunk.choices.length, 1);
    assert.equal(chunk.choices[0].index, 0);
  }
  assert.deepEqual(first.choices[0].delta, { role: 'assistant', content: '' });
  assert.equal(first.choices[0].finish_reason, null);
  assert.deepEqual(middle.choices[0].delta, { content: 'Hel' });
  assert.equal(middle.choices[0].finish_reason, null);
  assert.deepEqual(last.choices[0].delta, {});
  assert.equal(last.choices[0].finish_reason, 'length');
});

test('modelsList returns the OpenAI list shape', () => {
  assert.deepEqual(modelsList(['claude-a', 'claude-b'], { created: 1234 }), {
    object: 'list',
    data: [
      { id: 'claude-a', object: 'model', created: 1234, owned_by: 'anthropic' },
      { id: 'claude-b', object: 'model', created: 1234, owned_by: 'anthropic' },
    ],
  });
});

test('openaiErrorBody picks the OpenAI error type from the status', () => {
  assert.deepEqual(openaiErrorBody(400, 'Bad.', 'MESSAGES_INVALID'), {
    error: { message: 'Bad.', type: 'invalid_request_error', code: 'MESSAGES_INVALID', param: null },
  });
  assert.equal(openaiErrorBody(401, 'x').error.type, 'authentication_error');
  assert.equal(openaiErrorBody(403, 'x').error.type, 'authentication_error');
  assert.equal(openaiErrorBody(429, 'x').error.type, 'rate_limit_error');
  assert.equal(openaiErrorBody(500, 'x').error.type, 'server_error');
  assert.equal(openaiErrorBody(404, 'x').error.code, null);
});
