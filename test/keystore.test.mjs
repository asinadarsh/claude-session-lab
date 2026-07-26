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
  await store.close();

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
  await reopened.close();
  const again = await openKeystore({ file, masterKey });
  assert.deepEqual(await again.getTokens(connection.id), sampleTokens(2));
  await again.close();
});

test('wrong master key produces KEYSTORE_UNREADABLE', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  await store.createConnection({ tokens: sampleTokens() });
  await store.close();
  await assert.rejects(
    openKeystore({ file, masterKey: randomBytes(32) }),
    (error) => error.code === 'KEYSTORE_UNREADABLE',
  );
});

test('corrupt file and unknown version produce KEYSTORE_UNREADABLE', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  await store.createConnection({ tokens: sampleTokens() });
  await store.close();

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
  await store.close();

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

  const files = (await readdir(dirname(file))).filter((name) => !name.endsWith('.lock'));
  assert.deepEqual(files, ['keystore.json']);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.records.length, 3);

  await store.close();
  const reopened = await openKeystore({ file, masterKey });
  assert.equal(reopened.size, 3);
  await reopened.close();
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

test('a second writer is refused while the keystore is open, and the lock is released on close', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const { apiKey } = await store.createConnection({ label: 'first', tokens: sampleTokens(1) });

  // A second in-memory copy would rewrite the whole file and silently drop this key.
  await assert.rejects(
    openKeystore({ file, masterKey }),
    (error) => error.code === 'KEYSTORE_LOCKED' && error.status === 409,
  );

  await store.close();
  const second = await openKeystore({ file, masterKey });
  assert.ok(second.findByApiKey(apiKey), 'the first writer\'s key must survive');
  await second.close();
});

test('a lock left by a dead process is stolen rather than blocking forever', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  await store.createConnection({ label: 'held', tokens: sampleTokens(1) });
  await store.close();

  // An unused pid stands in for a crashed owner.
  await writeFile(`${file}.lock`, '2147483measure\n'.replace('measure', '000'));
  const reopened = await openKeystore({ file, masterKey });
  assert.equal(reopened.size, 1);
  await reopened.close();
});

test('two keys for one account share a lock, and the fingerprint never reaches the public view', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const account = { uuid: 'acct-uuid-1', emailAddress: 'owner@example.com' };
  const a = await store.createConnection({ label: 'site-a', tokens: { ...sampleTokens(1), tokenAccount: account } });
  const b = await store.createConnection({ label: 'site-b', tokens: { ...sampleTokens(2), tokenAccount: account } });

  for (const view of store.listConnections()) {
    assert.ok(!('accountKey' in view), 'the account fingerprint must not be exposed');
  }

  // Distinct records, one account: their runs must not overlap or both would rotate the token.
  const order = [];
  const first = store.withLock(a.connection.id, async () => {
    order.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push('a:end');
  });
  const second = store.withLock(b.connection.id, async () => {
    order.push('b:start');
    order.push('b:end');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
  await store.close();
});

test('a rotated refresh token does not split one account into two locks', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const account = { uuid: 'acct-uuid-2', emailAddress: 'owner@example.com' };
  const { connection } = await store.createConnection({ label: 'a', tokens: { ...sampleTokens(1), tokenAccount: account } });
  await store.updateTokens(connection.id, { ...sampleTokens(9), refreshToken: 'rotated-refresh', tokenAccount: account });
  const { connection: later } = await store.createConnection({ label: 'b', tokens: { ...sampleTokens(9), refreshToken: 'rotated-refresh', tokenAccount: account } });

  const order = [];
  await Promise.all([
    store.withLock(connection.id, async () => {
      order.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('first:end');
    }),
    store.withLock(later.id, () => { order.push('second'); }),
  ]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
  await store.close();
});

test('revoking one key of a shared account does not surrender the shared refresh token', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const account = { uuid: 'acct-shared', emailAddress: 'owner@example.com' };
  const tokens = { ...sampleTokens(1), refreshToken: 'shared-refresh', tokenAccount: account };
  const a = await store.createConnection({ label: 'site-a', tokens });
  const b = await store.createConnection({ label: 'site-b', tokens });

  // A live sibling still needs this token, so it must not be handed back for upstream revocation.
  assert.equal(await store.revoke(a.connection.id), null);
  assert.ok(store.findByApiKey(b.apiKey), 'the sibling key must keep working');
  assert.equal(store.findByApiKey(a.apiKey), null);

  // The last key for the account does surrender it.
  assert.equal(await store.revoke(b.connection.id), 'shared-refresh');
  await store.close();
});

test('a record written before account fingerprints existed is backfilled on open', async (t) => {
  const file = await tempFile(t);
  const store = await openKeystore({ file, masterKey });
  const account = { uuid: 'legacy-acct', emailAddress: 'legacy@example.com' };
  const { connection, apiKey } = await store.createConnection({ label: 'legacy', tokens: { ...sampleTokens(1), tokenAccount: account } });
  await store.close();

  // Simulate the pre-fingerprint on-disk shape.
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  delete onDisk.records[0].accountKey;
  await writeFile(file, JSON.stringify(onDisk));

  const reopened = await openKeystore({ file, masterKey });
  const sibling = await reopened.createConnection({ label: 'new', tokens: { ...sampleTokens(2), tokenAccount: account } });

  // Backfill makes the legacy record visible to the shared-account rules again.
  assert.equal(await reopened.revoke(connection.id), null, 'must not surrender a token a live sibling shares');
  assert.ok(reopened.findByApiKey(sibling.apiKey));
  assert.equal(reopened.findByApiKey(apiKey), null);
  await reopened.close();

  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(persisted.records.every((record) => record.revokedAt || record.accountKey), 'backfill must be persisted');
});
