import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKeystore, parseMasterKey } from '../src/keystore.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The sandbox gives the CLI a clean environment, so the lock path is baked in at write time.
const fakeCli = (lockFile) => `#!/usr/bin/env node
import { open, rm } from 'node:fs/promises';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const line = JSON.parse(raw.trim().split('\\n').pop());
const blocks = line.message.content;
const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');

// Fails if a second run overlaps, which proves per-connection serialization.
const lock = ${JSON.stringify(lockFile)};
let handle = null;
try {
  handle = await open(lock, 'wx');
} catch {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'concurrent run detected' }));
  process.exit(0);
}
await new Promise((resolve) => setTimeout(resolve, 60));

const reply = 'echo:' + text.slice(-60) + '|images=' + blocks.filter((b) => b.type === 'image').length;
const msg = { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } };
const emit = (event) => console.log(JSON.stringify({ type: 'stream_event', event }));
emit({ type: 'message_start', message: msg });
emit({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
emit({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } });
emit({ type: 'content_block_stop', index: 0 });
emit({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
emit({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: reply } });
emit({ type: 'content_block_stop', index: 1 });
emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
emit({ type: 'message_stop' });
console.log(JSON.stringify({ type: 'assistant', message: { ...msg, content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: reply }] } }));
console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1785122400, rateLimitType: 'five_hour' } }));
console.log(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: reply, duration_ms: 5,
  usage: { input_tokens: 7, output_tokens: 5 }, modelUsage: { 'claude-sonnet-5': {} },
}));
await handle.close();
await rm(lock, { force: true });
`;

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), 'csl-gateway-'));
  const binary = join(dir, 'fake-claude.mjs');
  await writeFile(binary, fakeCli(join(dir, 'run.lock')), { mode: 0o700 });
  await chmod(binary, 0o700);

  const masterKeyRaw = randomBytes(32).toString('base64');
  const keystoreFile = join(dir, 'keystore.json');
  const keystore = await openKeystore({ file: keystoreFile, masterKey: parseMasterKey(masterKeyRaw) });
  const { apiKey } = await keystore.createConnection({
    label: 'integration',
    tokens: {
      accessToken: 'access-placeholder',
      refreshToken: 'refresh-placeholder',
      expiresAt: Date.now() + 3600000,
      refreshTokenExpiresAt: Date.now() + 7200000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      tokenAccount: { emailAddress: 'tester@example.com' },
    },
    profile: null,
  });
  await keystore.flush();

  const port = 31000 + Math.floor(Math.random() * 3000);
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SESSION_LAB_GATEWAY: '1',
      SESSION_LAB_MASTER_KEY: masterKeyRaw,
      SESSION_LAB_KEYSTORE: keystoreFile,
      SESSION_LAB_PORT: String(port),
      SESSION_LAB_RATE_LIMIT_PER_MINUTE: '200',
      CLAUDE_BINARY: binary,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${log}`);
    try {
      const probe = await fetch(`${base}/api/health`);
      if (probe.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`server did not start: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    base,
    port,
    apiKey,
    log: () => log,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function messagesBody(extra = {}) {
  return JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: 'ping' }],
    ...extra,
  });
}

test('gateway surface', async (t) => {
  const server = await startServer();
  const headers = { 'content-type': 'application/json', 'x-api-key': server.apiKey };

  try {
    await t.test('rejects a missing key', async () => {
      const response = await fetch(`${server.base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: messagesBody(),
      });
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.type, 'error');
      assert.equal(body.error.type, 'authentication_error');
    });

    await t.test('rejects a forged key', async () => {
      const response = await fetch(`${server.base}/v1/messages`, {
        method: 'POST',
        headers: { ...headers, 'x-api-key': `${server.apiKey.slice(0, -2)}xx` },
        body: messagesBody(),
      });
      assert.equal(response.status, 401);
    });

    await t.test('accepts Authorization: Bearer', async () => {
      const response = await fetch(`${server.base}/v1/models`, {
        headers: { authorization: `Bearer ${server.apiKey}` },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.object, 'list');
      assert.ok(body.data.length > 0);
    });

    await t.test('returns an Anthropic Message for a buffered request', async () => {
      const response = await fetch(`${server.base}/v1/messages`, { method: 'POST', headers, body: messagesBody() });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.type, 'message');
      assert.equal(body.role, 'assistant');
      assert.equal(body.stop_reason, 'end_turn');
      assert.equal(body.model, 'claude-sonnet-5');
      assert.deepEqual(body.content.map((block) => block.type), ['text'], 'thinking must be hidden by default');
      assert.match(body.content[0].text, /^echo:ping/);
      assert.equal(body.usage.input_tokens, 7);
      assert.equal(body.usage.output_tokens, 5);
      assert.equal(response.headers.get('x-claude-ratelimit-status'), 'allowed');
      assert.ok(response.headers.get('x-request-id'));
    });

    await t.test('keeps thinking blocks when the caller asks for them', async () => {
      const response = await fetch(`${server.base}/v1/messages`, {
        method: 'POST',
        headers,
        body: messagesBody({ thinking: { type: 'enabled', budget_tokens: 1024 } }),
      });
      const body = await response.json();
      assert.deepEqual(body.content.map((block) => block.type), ['thinking', 'text']);
    });

    await t.test('flattens prior turns into a single sandbox call', async () => {
      const response = await fetch(`${server.base}/v1/messages`, {
        method: 'POST',
        headers,
        body: messagesBody({
          messages: [
            { role: 'user', content: 'my codeword is ZOGDAR' },
            { role: 'assistant', content: 'noted' },
            { role: 'user', content: 'repeat it' },
          ],
        }),
      });
      const body = await response.json();
      assert.match(body.content[0].text, /repeat it/);
    });

    await t.test('streams Anthropic SSE with contiguous block indexes', async () => {
      const response = await fetch(`${server.base}/v1/messages`, {
        method: 'POST',
        headers,
        body: messagesBody({ stream: true }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const raw = await response.text();
      const events = [...raw.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
      assert.deepEqual(events, [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ], 'thinking block events must be suppressed');
      const payloads = [...raw.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
      const started = payloads.find((event) => event.type === 'content_block_start');
      assert.equal(started.index, 0, 'surviving text block must be re-indexed to 0');
      assert.equal(started.content_block.type, 'text');
      const delta = payloads.find((event) => event.type === 'content_block_delta');
      assert.equal(delta.index, 0);
      assert.match(delta.delta.text, /^echo:ping/);
    });

    await t.test('serves the OpenAI chat completions shape', async () => {
      const response = await fetch(`${server.base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          messages: [
            { role: 'system', content: 'be terse' },
            { role: 'user', content: 'ping' },
          ],
          max_tokens: 300,
          temperature: 0.5,
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.object, 'chat.completion');
      assert.equal(body.choices[0].message.role, 'assistant');
      assert.equal(body.choices[0].finish_reason, 'stop');
      assert.match(body.choices[0].message.content, /^echo:/);
      assert.equal(body.usage.completion_tokens, 5);
    });

    await t.test('streams OpenAI chunks terminated by [DONE]', async () => {
      const response = await fetch(`${server.base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          messages: [{ role: 'user', content: 'ping' }],
          stream: true,
        }),
      });
      assert.equal(response.status, 200);
      const raw = await response.text();
      assert.ok(raw.endsWith('data: [DONE]\n\n'), 'stream must terminate with [DONE]');
      const chunks = [...raw.matchAll(/^data: (\{.+\})$/gm)].map((match) => JSON.parse(match[1]));
      assert.equal(chunks[0].choices[0].delta.role, 'assistant');
      assert.match(chunks[1].choices[0].delta.content, /^echo:/);
      assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
      assert.ok(chunks.every((chunk) => chunk.object === 'chat.completion.chunk' && chunk.id === chunks[0].id));
      assert.match(chunks[0].id, /^chatcmpl-[A-Za-z0-9_-]+$/, 'id must carry exactly one chatcmpl- prefix');
      assert.equal(chunks[0].model, 'claude-sonnet-5', 'chunks report the served model, not the alias');
    });

    await t.test('rejects tool use with an OpenAI error envelope', async () => {
      const response = await fetch(`${server.base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          messages: [{ role: 'user', content: 'ping' }],
          tools: [{ type: 'function', function: { name: 'do_thing' } }],
        }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.type, 'invalid_request_error');
      assert.equal(body.error.param, null);
    });

    await t.test('serializes concurrent requests for one key', async () => {
      const responses = await Promise.all([1, 2, 3].map(() => fetch(`${server.base}/v1/messages`, {
        method: 'POST',
        headers,
        body: messagesBody(),
      })));
      const bodies = await Promise.all(responses.map((response) => response.json()));
      for (const [index, response] of responses.entries()) {
        assert.equal(response.status, 200, `request ${index} failed: ${JSON.stringify(bodies[index])}`);
      }
    });

    await t.test('reports an unknown gateway path with the Anthropic envelope', async () => {
      const response = await fetch(`${server.base}/v1/embeddings`, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.equal(body.error.type, 'not_found_error');
    });

    await t.test('keeps the admin UI off non-localhost hosts', async () => {
      // fetch() forbids overriding Host, so this one goes out over a raw socket.
      const status = await new Promise((resolve, reject) => {
        const request = httpRequest({
          host: '127.0.0.1',
          port: server.port,
          path: '/api/auth/status',
          method: 'GET',
          headers: { host: 'gateway.example.com' },
        }, (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        request.on('error', reject);
        request.end();
      });
      assert.equal(status, 421);
    });

    await t.test('never logs the API key or tokens', () => {
      const log = server.log();
      assert.ok(!log.includes(server.apiKey));
      assert.ok(!log.includes('access-placeholder'));
      assert.ok(!log.includes('refresh-placeholder'));
    });
  } finally {
    await server.stop();
  }
});
