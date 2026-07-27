import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCredentialPayload, buildUserLine, runClaudePrompt, runClaudeStream } from '../src/claude.mjs';

const tokens = {
  accessToken: 'access-placeholder',
  refreshToken: 'refresh-placeholder',
  expiresAt: Date.now() + 3600000,
  refreshTokenExpiresAt: Date.now() + 7200000,
  scopes: ['user:inference'],
  subscriptionType: 'max',
  rateLimitTier: 'test-tier',
};

async function writeFakeCli(prefix, source) {
  const fixture = await mkdtemp(join(tmpdir(), prefix));
  const binary = join(fixture, 'fake-claude.mjs');
  await writeFile(binary, source, { mode: 0o700 });
  await chmod(binary, 0o700);
  return { fixture, binary };
}

const ECHO_CLI = `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const line = JSON.parse(raw.trim().split('\\n').pop());
const text = line.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
const images = line.message.content.filter((b) => b.type === 'image').length;
const flags = process.argv.slice(2).join(' ');
const promptFileIndex = process.argv.indexOf('--system-prompt-file');
const systemPrompt = promptFileIndex > 0
  ? await readFile(process.argv[promptFileIndex + 1], 'utf8')
  : null;
const credentialPath = join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
const credential = JSON.parse(await readFile(credentialPath, 'utf8'));
credential.claudeAiOauth.accessToken = 'updated-access-placeholder';
credential.claudeAiOauth.refreshToken = 'updated-refresh-placeholder';
await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
const reply = 'fixture:' + text + '|images=' + images;
console.log(JSON.stringify({ type: 'system', subtype: 'init', flags, systemPrompt, maxOut: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } }));
console.log(JSON.stringify({ type: 'assistant', message: { model: 'fixture-model', content: [{ type: 'text', text: reply }] } }));
console.log(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: reply, duration_ms: 12,
  usage: { input_tokens: 2, output_tokens: 3 },
  modelUsage: { 'fixture-model': {} },
}));
`;

test('credential payload uses Claude Code schema without unrelated fields', () => {
  assert.deepEqual(buildCredentialPayload(tokens), {
    claudeAiOauth: {
      accessToken: 'access-placeholder',
      expiresAt: tokens.expiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      scopes: ['user:inference'],
      refreshToken: 'refresh-placeholder',
      subscriptionType: 'max',
      rateLimitTier: 'test-tier',
    },
  });
});

test('isolated runner captures response and refreshed credentials', async () => {
  const { fixture, binary } = await writeFakeCli('fake-claude-', ECHO_CLI);
  try {
    const output = await runClaudePrompt({ tokens, prompt: 'hello', binary, timeoutMs: 5000 });
    assert.equal(output.response.text, 'fixture:hello|images=0');
    assert.equal(output.response.model, 'fixture-model');
    assert.equal(output.response.inputTokens, 2);
    assert.equal(output.updatedTokens.accessToken, 'updated-access-placeholder');
    assert.equal(output.updatedTokens.refreshToken, 'updated-refresh-placeholder');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('streaming runner forwards every stdout object and applies sandbox flags', async () => {
  const { fixture, binary } = await writeFakeCli('fake-claude-stream-', ECHO_CLI);
  try {
    const events = [];
    const { updatedTokens, aborted } = await runClaudeStream({
      tokens,
      cliInputLine: buildUserLine('streamed'),
      binary,
      model: 'sonnet',
      systemPrompt: 'be terse',
      maxTokens: 512,
      timeoutMs: 5000,
      onEvent: (obj) => events.push(obj),
    });

    assert.equal(aborted, false);
    assert.equal(updatedTokens.accessToken, 'updated-access-placeholder');
    assert.deepEqual(events.map((event) => event.type), ['system', 'stream_event', 'assistant', 'result']);
    const init = events[0];
    assert.equal(init.maxOut, '512');
    for (const flag of ['--tools', '--strict-mcp-config', '--setting-sources', '--no-session-persistence', '--system-prompt-file', '--include-partial-messages']) {
      assert.ok(init.flags.includes(flag), `expected ${flag} in CLI flags`);
    }
    // The prompt must travel in a file, never on the command line.
    assert.equal(init.systemPrompt, 'be terse');
    assert.ok(!init.flags.includes('be terse'), 'caller text must not appear in argv');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('streaming runner rejects a multi-line CLI input line', async () => {
  await assert.rejects(
    runClaudeStream({ tokens, cliInputLine: '{"a":1}\n{"b":2}', binary: process.execPath }),
    (error) => error.code === 'CLI_INPUT_INVALID',
  );
});

test('streaming runner reports abort instead of throwing', async () => {
  const { fixture, binary } = await writeFakeCli('fake-claude-abort-', `#!/usr/bin/env node
process.on('SIGTERM', () => process.exit(143));
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100).unref();
  try {
    const outcome = await runClaudeStream({
      tokens,
      cliInputLine: buildUserLine('abort me'),
      binary,
      timeoutMs: 10000,
      signal: controller.signal,
    });
    assert.equal(outcome.aborted, true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('isolated runner terminates a hung process on deadline', async () => {
  const { fixture, binary } = await writeFakeCli('fake-claude-hang-', `#!/usr/bin/env node
process.on('SIGTERM', () => process.exit(143));
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  try {
    await assert.rejects(
      runClaudePrompt({ tokens, prompt: 'hang', binary, timeoutMs: 120 }),
      (error) => error.code === 'CLAUDE_TIMEOUT',
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('missing CLI binary surfaces a clear error', async () => {
  await assert.rejects(
    runClaudePrompt({ tokens, prompt: 'hi', binary: '/nonexistent/claude-binary', timeoutMs: 2000 }),
    (error) => error.code === 'CLAUDE_BINARY_MISSING',
  );
});
