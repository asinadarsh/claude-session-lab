import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCredentialPayload, runClaudePrompt } from '../src/claude.mjs';

const tokens = {
  accessToken: 'access-placeholder',
  refreshToken: 'refresh-placeholder',
  expiresAt: Date.now() + 3600000,
  refreshTokenExpiresAt: Date.now() + 7200000,
  scopes: ['user:inference'],
  subscriptionType: 'max',
  rateLimitTier: 'test-tier',
};

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
  const fixture = await mkdtemp(join(tmpdir(), 'fake-claude-'));
  const binary = join(fixture, 'fake-claude.mjs');
  await writeFile(binary, `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const credentialPath = join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
const credential = JSON.parse(await readFile(credentialPath, 'utf8'));
credential.claudeAiOauth.accessToken = 'updated-access-placeholder';
credential.claudeAiOauth.refreshToken = 'updated-refresh-placeholder';
await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
console.log(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: 'fixture:' + prompt.trim(), duration_ms: 12,
  usage: { input_tokens: 2, output_tokens: 3 },
  modelUsage: { 'fixture-model': {} }
}));
`, { mode: 0o700 });
  await chmod(binary, 0o700);

  try {
    const output = await runClaudePrompt({ tokens, prompt: 'hello', binary, timeoutMs: 2000 });
    assert.equal(output.response.text, 'fixture:hello');
    assert.equal(output.response.model, 'fixture-model');
    assert.equal(output.updatedTokens.accessToken, 'updated-access-placeholder');
    assert.equal(output.updatedTokens.refreshToken, 'updated-refresh-placeholder');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('isolated runner terminates a hung process on deadline', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'fake-claude-hang-'));
  const binary = join(fixture, 'fake-claude-hang.mjs');
  await writeFile(binary, `#!/usr/bin/env node
process.on('SIGTERM', () => process.exit(143));
process.stdin.resume();
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await chmod(binary, 0o700);

  try {
    await assert.rejects(
      runClaudePrompt({ tokens, prompt: 'hang', binary, timeoutMs: 80 }),
      (error) => error.code === 'CLAUDE_TIMEOUT',
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
