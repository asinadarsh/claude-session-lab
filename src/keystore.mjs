import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PublicError, constantTimeEqual, maskEmail, randomToken } from './security.mjs';

const masterKeyError = () =>
  new PublicError(500, 'MASTER_KEY_INVALID', 'The master key must be 32 bytes encoded as base64, base64url, or 64-character hex.');

const unreadableError = () =>
  new PublicError(500, 'KEYSTORE_UNREADABLE', 'The keystore file could not be read or decrypted. Refusing to touch existing data.');

const notFoundError = () =>
  new PublicError(404, 'CONNECTION_NOT_FOUND', 'No connection exists with that id.');

const lockedError = (pid) =>
  new PublicError(409, 'KEYSTORE_LOCKED', `Another process (pid ${pid}) already has this keystore open. Stop it, or use the admin UI instead.`);

/**
 * Stable identity for the Claude account behind a connection, used to serialize runs across
 * every key that shares it. Account uuid and email come first because they survive a refresh
 * token rotation; the token hash is only a last resort. Always hashed, so the record never
 * carries the raw value.
 */
function accountFingerprint(tokens, profile) {
  const seed = tokens?.tokenAccount?.uuid
    ?? profile?.emailAddress
    ?? tokens?.tokenAccount?.emailAddress
    ?? tokens?.refreshToken
    ?? null;
  return seed ? createHash('sha256').update(String(seed)).digest('hex').slice(0, 32) : null;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Every writer rewrites the whole file from its own in-memory records, so two writers would
 * silently drop each other's changes. A lock held for the keystore's lifetime makes that a
 * clear error instead. A lock whose owner is gone is stolen rather than blocking forever.
 */
async function acquireLock(lockFile) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      await handle.write(`${process.pid}\n`);
      await handle.sync();
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number.parseInt(await readFile(lockFile, 'utf8').catch(() => ''), 10);
      if (processAlive(owner) || owner === process.pid) throw lockedError(owner || 'unknown');
      await unlink(lockFile).catch(() => {});
    }
  }
  throw lockedError('unknown');
}

export function parseMasterKey(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw masterKeyError();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw masterKeyError();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw masterKeyError();
  return key;
}

function encryptTokens(masterKey, id, tokens) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptTokens(masterKey, id, secret) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(secret.iv, 'base64'));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(secret.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw unreadableError();
  }
}

function sanitizeLabel(label) {
  const clean = String(label ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);
  return clean || 'default';
}

function publicView(record) {
  const {
    id, label, keyPrefix, createdAt, lastUsedAt, revokedAt,
    requestCount, errorCount, totalInputTokens, totalOutputTokens, account,
  } = record;
  return {
    id, label, keyPrefix, createdAt, lastUsedAt, revokedAt,
    requestCount, errorCount, totalInputTokens, totalOutputTokens,
    account: { ...account },
  };
}

export async function openKeystore({ file, masterKey }) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw masterKeyError();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });

  const lockFile = `${file}.lock`;
  const lockHandle = await acquireLock(lockFile);
  const releaseLockSync = () => {
    try { unlinkSync(lockFile); } catch {}
  };
  process.once('exit', releaseLockSync);

  let records = [];
  let needsBackfill = false;
  let raw = null;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw unreadableError();
  }
  if (raw !== null) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await lockHandle.close().catch(() => {});
      releaseLockSync();
      throw unreadableError();
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.records)) {
      await lockHandle.close().catch(() => {});
      releaseLockSync();
      throw unreadableError();
    }
    records = parsed.records;
    try {
      for (const record of records) {
        if (!record.secret) continue;
        const tokens = decryptTokens(masterKey, record.id, record.secret);
        // Records written before account fingerprints existed would otherwise be invisible to
        // the shared-account checks that guard locking and upstream revocation.
        if (!record.accountKey) {
          record.accountKey = accountFingerprint(tokens, null);
          needsBackfill = needsBackfill || Boolean(record.accountKey);
        }
      }
    } catch (error) {
      await lockHandle.close().catch(() => {});
      releaseLockSync();
      throw error;
    }
  }

  const tmp = `${file}.tmp`;
  // A rename alone can be reordered against the data write on a crash, which for a credential
  // store means a rotated-out refresh token or an empty file surviving instead of the new one.
  const persist = async () => {
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, records }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    const dir = await open(dirname(file), 'r');
    try {
      await dir.sync();
    } catch {
      // Directory fsync is unsupported on some filesystems; the data fsync above still holds.
    } finally {
      await dir.close();
    }
  };
  let writeChain = Promise.resolve();
  const save = () => {
    const run = writeChain.then(persist, persist);
    writeChain = run.then(() => {}, () => {});
    return run;
  };

  if (needsBackfill) await save();

  const find = (id) => records.find((record) => record.id === id) ?? null;
  const mustFind = (id) => {
    const record = find(id);
    if (!record || record.revokedAt) throw notFoundError();
    return record;
  };

  const locks = new Map();

  return {
    async createConnection({ label, tokens, profile } = {}) {
      const id = randomToken(16);
      const apiKey = `csl_sk_${randomToken(24)}`;
      const record = {
        id,
        label: sanitizeLabel(label),
        keyHash: createHash('sha256').update(apiKey).digest('hex'),
        keyPrefix: apiKey.slice(0, 12),
        accountKey: accountFingerprint(tokens, profile),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        requestCount: 0,
        errorCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        account: {
          emailMasked: maskEmail(profile?.emailAddress ?? tokens?.tokenAccount?.emailAddress),
          plan: profile?.subscriptionType ?? tokens?.subscriptionType ?? null,
          rateLimitTier: profile?.rateLimitTier ?? tokens?.rateLimitTier ?? null,
        },
        secret: encryptTokens(masterKey, id, tokens),
      };
      records.unshift(record);
      await save();
      return { connection: publicView(record), apiKey };
    },

    listConnections() {
      return records.map(publicView);
    },

    findByApiKey(apiKey) {
      if (typeof apiKey !== 'string' || !apiKey.startsWith('csl_sk_')) return null;
      const digest = createHash('sha256').update(apiKey).digest('hex');
      let found = null;
      for (const record of records) {
        if (constantTimeEqual(digest, record.keyHash) && !record.revokedAt) found = record;
      }
      return found;
    },

    async getTokens(id) {
      const record = mustFind(id);
      return decryptTokens(masterKey, record.id, record.secret);
    },

    async updateTokens(id, tokens) {
      const record = mustFind(id);
      record.secret = encryptTokens(masterKey, record.id, tokens);
      await save();
    },

    async recordUsage(id, { inputTokens = 0, outputTokens = 0, ok = true } = {}) {
      const record = mustFind(id);
      record.lastUsedAt = new Date().toISOString();
      record.requestCount += 1;
      if (!ok) record.errorCount += 1;
      record.totalInputTokens += Number(inputTokens) || 0;
      record.totalOutputTokens += Number(outputTokens) || 0;
      await save();
    },

    /**
     * Revokes one key locally and returns its refresh token for upstream revocation — but only
     * when no other live key shares the same account. Sibling keys hold the same refresh token,
     * and revoking it upstream would sign all of them out along with any Claude Code install
     * using that account.
     */
    async revoke(id) {
      const record = find(id);
      if (!record) throw notFoundError();
      if (record.revokedAt) return null;
      const tokens = record.secret ? decryptTokens(masterKey, record.id, record.secret) : null;
      record.revokedAt = new Date().toISOString();
      record.secret = null;
      await save();
      const sharedWithLiveSibling = record.accountKey
        && records.some((other) => other.id !== record.id && !other.revokedAt && other.accountKey === record.accountKey);
      if (sharedWithLiveSibling) return null;
      return tokens?.refreshToken ?? null;
    },

    // Keyed by account, not by record: several keys can point at one Claude account, and two
    // concurrent runs against the same account would each rotate its refresh token and
    // invalidate the other. Records without a fingerprint fall back to their own id.
    withLock(id, fn) {
      const key = find(id)?.accountKey ?? id;
      const prev = locks.get(key) ?? Promise.resolve();
      const run = prev.then(() => fn());
      const tail = run.then(() => {}, () => {});
      locks.set(key, tail);
      tail.then(() => {
        if (locks.get(key) === tail) locks.delete(key);
      });
      return run;
    },

    flush() {
      return writeChain;
    },

    async close() {
      await writeChain.catch(() => {});
      await lockHandle.close().catch(() => {});
      releaseLockSync();
      process.removeListener('exit', releaseLockSync);
    },

    get size() {
      return records.filter((record) => !record.revokedAt).length;
    },
  };
}
