import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openKeystore, parseMasterKey } from '../src/keystore.mjs';

const masterKey = randomBytes(32);

function sampleTokens(n = 1) {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: 1753600000000 + n,
    refreshTokenExpiresAt: 1785100000000 + n,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    tokenAccount: {
      uuid: `uuid-${n}`,
      emailAddress: 'testaccount@example.com',
      organizationUuid: `org-${n}`,
    },
  };
}

async function tempFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'keystore-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'nested', 'keystore.json');
}

test('parseMasterKey accepts hex, base64, and base64url; rejects bad input', () => {
  const key = randomBytes(32);
  assert.deepEqual(parseMasterKey(key.toString('hex')), key);
  assert.deepEqual(parseMasterKey(key.toString('base64')), key);
  assert.deepEqual(parseMasterKey(key.toString('base64url')), key);
  for (const bad of ['', 'short', randomBytes(16).toString('hex'), '!!!not-a-key!!!', null]) {
    assert.throws(() => parseMasterKey(bad), (error) => error.code === 'MASTER_KEY_INVALID');
  }
});

test('round-trip persistence across reopen, updateTokens, and usage counters', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const { connection, apiKey } = await store.createConnection({
    label: 'work',
    tokens: sampleTokens(1),
    profile: { emailAddress: 'testaccount@example.com', displayName: 'T', subscriptionType: 'max', rateLimitTier: 'tier1' },
  });

  assert.match(apiKey, /^csl_sk_[A-Za-z0-9_-]{32}$/);
  assert.equal(connection.keyPrefix, apiKey.slice(0, 12));
  assert.equal(connection.account.emailMasked, 'te********@example.com');
  assert.equal(connection.account.plan, 'max');
  assert.deepEqual(
    Object.keys(connection).sort(),
    ['account', 'createdAt', 'errorCount', 'id', 'keyPrefix', 'label', 'lastUsedAt', 'requestCount', 'revokedAt', 'totalInputTokens', 'totalOutputTokens'],
  );

  await store.recordUsage(connection.id, { inputTokens: 10, outputTokens: 20, ok: false });
  await store.flush();

  const reopened = await openKeystore({ file, masterKey });
  assert.equal(reopened.size, 1);
  assert.deepEqual(await reopened.getTokens(connection.id), sampleTokens(1));
  const [view] = reopened.listConnections();
  assert.equal(view.requestCount, 1);
  assert.equal(view.errorCount, 1);
  assert.equal(view.totalInputTokens, 10);
  assert.equal(view.totalOutputTokens, 20);
  assert.ok(view.lastUsedAt);

  await reopened.updateTokens(connection.id, sampleTokens(2));
  const again = await openKeystore({ file, masterKey });
  assert.deepEqual(await again.getTokens(connection.id), sampleTokens(2));
});

test('wrong master key produces KEYSTORE_UNREADABLE', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  await store.createConnection({ tokens: sampleTokens() });
  await store.flush();
  await assert.rejects(
    openKeystore({ file, masterKey: randomBytes(32) }),
    (error) => error.code === 'KEYSTORE_UNREADABLE',
  );
});

test('corrupt file and unknown version produce KEYSTORE_UNREADABLE', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  await store.createConnection({ tokens: sampleTokens() });
  await store.flush();

  const original = await readFile(file, 'utf8');
  await writeFile(file, 'not json {');
  await assert.rejects(openKeystore({ file, masterKey }), (error) => error.code === 'KEYSTORE_UNREADABLE');

  const parsed = JSON.parse(original);
  parsed.version = 2;
  await writeFile(file, JSON.stringify(parsed));
  await assert.rejects(openKeystore({ file, masterKey }), (error) => error.code === 'KEYSTORE_UNREADABLE');
});

test('findByApiKey accepts the real key, rejects near-miss, tampered, and revoked', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const { connection, apiKey } = await store.createConnection({ tokens: sampleTokens() });

  assert.equal(store.findByApiKey(apiKey)?.id, connection.id);

  const nearMiss = apiKey.slice(0, -1) + (apiKey.endsWith('A') ? 'B' : 'A');
  assert.equal(store.findByApiKey(nearMiss), null);
  assert.equal(store.findByApiKey(`csl_sk_${'A'.repeat(32)}`), null);
  assert.equal(store.findByApiKey('not-a-key'), null);
  assert.equal(store.findByApiKey(null), null);
  assert.equal(store.findByApiKey(''), null);

  await store.revoke(connection.id);
  assert.equal(store.findByApiKey(apiKey), null);
});

test('AAD binding: swapping two records secret blobs makes the keystore unreadable', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  await store.createConnection({ label: 'one', tokens: sampleTokens(1) });
  await store.createConnection({ label: 'two', tokens: sampleTokens(2) });
  await store.flush();

  const parsed = JSON.parse(await readFile(file, 'utf8'));
  [parsed.records[0].secret, parsed.records[1].secret] = [parsed.records[1].secret, parsed.records[0].secret];
  await writeFile(file, JSON.stringify(parsed));

  await assert.rejects(openKeystore({ file, masterKey }), (error) => error.code === 'KEYSTORE_UNREADABLE');
});

test('withLock serializes overlapping calls and survives a throwing callback', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const { connection } = await store.createConnection({ tokens: sampleTokens() });

  const order = [];
  const first = store.withLock(connection.id, async () => {
    order.push('a-start');
    await delay(25);
    order.push('a-end');
  });
  const second = store.withLock(connection.id, async () => {
    order.push('b');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);

  await assert.rejects(
    store.withLock(connection.id, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  await store.withLock(connection.id, async () => {
    order.push('after-throw');
  });
  assert.deepEqual(order, ['a-start', 'a-end', 'b', 'after-throw']);
});

test('revoke wipes the token blob, returns the refresh token, and is terminal', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const { connection } = await store.createConnection({ tokens: sampleTokens(7) });

  assert.equal(await store.revoke(connection.id), 'refresh-7');
  assert.equal(store.size, 0);
  await assert.rejects(store.getTokens(connection.id), (error) => error.code === 'CONNECTION_NOT_FOUND');
  assert.equal(await store.revoke(connection.id), null);
  await assert.rejects(store.revoke('missing-id'), (error) => error.code === 'CONNECTION_NOT_FOUND');
  await store.flush();

  const parsed = JSON.parse(await readFile(file, 'utf8'));
  const record = parsed.records.find((entry) => entry.id === connection.id);
  assert.equal(record.secret, null);
  assert.ok(record.revokedAt);
});

test('atomic writes leave no .tmp behind and keep valid JSON under concurrent saves', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const created = await Promise.all([
    store.createConnection({ label: 'a', tokens: sampleTokens(1) }),
    store.createConnection({ label: 'b', tokens: sampleTokens(2) }),
    store.createConnection({ label: 'c', tokens: sampleTokens(3) }),
  ]);
  await Promise.all(created.map(({ connection }) => store.recordUsage(connection.id, { inputTokens: 1, outputTokens: 1, ok: true })));
  await store.flush();

  const files = await readdir(dirname(file));
  assert.deepEqual(files, ['keystore.json']);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.records.length, 3);

  const reopened = await openKeystore({ file, masterKey });
  assert.equal(reopened.size, 3);
});

test('listConnections returns newest first and never leaks secrets', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const first = await store.createConnection({ label: 'older', tokens: sampleTokens(1) });
  const second = await store.createConnection({ label: 'newer', tokens: sampleTokens(2) });

  const views = store.listConnections();
  assert.deepEqual(views.map((view) => view.id), [second.connection.id, first.connection.id]);
  const serialized = JSON.stringify(views);
  assert.doesNotMatch(serialized, /access-|refresh-|keyHash|secret/);
});
