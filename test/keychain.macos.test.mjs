import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { decodeKeychainPayload, readLocalClaudeCredentials } from '../src/platform.mjs';

// Exercises the macOS Keychain path against the REAL `security` binary. Everything else in the
// suite fakes the spawn, which proves the parsing but not the command itself: whether the
// argument order is right, whether `-w` prints the payload, and what the exit code is on a miss.
//
// It writes to the login Keychain, so it only runs when explicitly opted in. CI sets
// CSL_KEYCHAIN_TEST=1 on the macOS runner; a developer on a Mac can do the same deliberately.
const run = promisify(execFile);
const ENABLED = process.platform === 'darwin' && process.env.CSL_KEYCHAIN_TEST === '1';
const SERVICE = 'Claude Code-credentials';
const ACCOUNT = userInfo().username;

const FIXTURE = {
  claudeAiOauth: {
    accessToken: 'keychain-access-fixture',
    refreshToken: 'keychain-refresh-fixture',
    expiresAt: 4102444800000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
};

async function addEntry(payload, { hex = false } = {}) {
  const args = ['add-generic-password', '-U', '-a', ACCOUNT, '-s', SERVICE];
  // -X takes the value hex-encoded, which is how the CLI itself writes this entry.
  args.push(hex ? '-X' : '-w', hex ? Buffer.from(payload, 'utf8').toString('hex') : payload);
  await run('security', args);
}

async function removeEntry() {
  try {
    await run('security', ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]);
  } catch {
    // Already gone: a failed add or a previous cleanup.
  }
}

test('macOS Keychain integration', { skip: ENABLED ? false : 'set CSL_KEYCHAIN_TEST=1 on macOS to run' }, async (t) => {
  await removeEntry();

  await t.test('reads a plain-text entry written by security', async () => {
    await addEntry(JSON.stringify(FIXTURE));
    try {
      const result = await readLocalClaudeCredentials({ env: {} });
      assert.equal(result.sourceKind, 'keychain', `expected the Keychain, got ${result.source}`);
      assert.match(result.source, /Claude Code-credentials/);
      assert.equal(result.oauth.accessToken, 'keychain-access-fixture');
      assert.equal(result.oauth.refreshToken, 'keychain-refresh-fixture');
    } finally {
      await removeEntry();
    }
  });

  await t.test('reads an entry stored hex-encoded, the way the CLI writes it', async () => {
    await addEntry(JSON.stringify(FIXTURE), { hex: true });
    try {
      const result = await readLocalClaudeCredentials({ env: {} });
      assert.equal(result.sourceKind, 'keychain');
      assert.equal(result.oauth.accessToken, 'keychain-access-fixture');
    } finally {
      await removeEntry();
    }
  });

  await t.test('honours CLAUDE_KEYCHAIN_SERVICE for a differently named entry', async () => {
    const custom = 'csl-test-custom-service';
    await run('security', ['add-generic-password', '-U', '-a', ACCOUNT, '-s', custom, '-w', JSON.stringify(FIXTURE)]);
    try {
      const result = await readLocalClaudeCredentials({ env: { CLAUDE_KEYCHAIN_SERVICE: custom } });
      assert.equal(result.sourceKind, 'keychain');
      assert.match(result.source, new RegExp(custom));
      assert.equal(result.oauth.accessToken, 'keychain-access-fixture');
    } finally {
      await run('security', ['delete-generic-password', '-a', ACCOUNT, '-s', custom]).catch(() => {});
    }
  });

  await t.test('falls back to the file when no entry exists, and reports both attempts', async () => {
    await assert.rejects(
      readLocalClaudeCredentials({
        env: {},
        home: '/nonexistent-home-for-csl-test',
        readFileImpl: async () => { const error = new Error('nope'); error.code = 'ENOENT'; throw error; },
      }),
      (error) => error.code === 'LOCAL_CREDENTIALS_UNAVAILABLE'
        && /no readable Keychain entry/.test(error.publicMessage)
        && /credentials\.json/.test(error.publicMessage),
    );
  });
});

// Payload decoding is pure, so it is worth checking everywhere, not just on macOS.
test('keychain payload decoding accepts both shapes and hex', () => {
  const wrapped = JSON.stringify({ claudeAiOauth: { accessToken: 'a' } });
  assert.equal(decodeKeychainPayload(wrapped).accessToken, 'a');
  assert.equal(decodeKeychainPayload(JSON.stringify({ accessToken: 'bare' })).accessToken, 'bare');
  assert.equal(decodeKeychainPayload(Buffer.from(wrapped, 'utf8').toString('hex')).accessToken, 'a');
  assert.equal(decodeKeychainPayload('  '), null);
  assert.equal(decodeKeychainPayload('not json'), null);
  assert.equal(decodeKeychainPayload(JSON.stringify({ claudeAiOauth: { accessToken: '' } })), null);
  assert.equal(decodeKeychainPayload(undefined), null);
});
