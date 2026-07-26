import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PublicError, constantTimeEqual, maskEmail, randomToken } from './security.mjs';

const masterKeyError = () =>
  new PublicError(500, 'MASTER_KEY_INVALID', 'The master key must be 32 bytes encoded as base64, base64url, or 64-character hex.');

const unreadableError = () =>
  new PublicError(500, 'KEYSTORE_UNREADABLE', 'The keystore file could not be read or decrypted. Refusing to touch existing data.');

const notFoundError = () =>
  new PublicError(404, 'CONNECTION_NOT_FOUND', 'No connection exists with that id.');

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

  let records = [];
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
      throw unreadableError();
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.records)) throw unreadableError();
    records = parsed.records;
    for (const record of records) {
      if (record.secret) decryptTokens(masterKey, record.id, record.secret);
    }
  }

  const tmp = `${file}.tmp`;
  const persist = async () => {
    await writeFile(tmp, JSON.stringify({ version: 1, records }), { mode: 0o600 });
    await rename(tmp, file);
  };
  let writeChain = Promise.resolve();
  const save = () => {
    const run = writeChain.then(persist, persist);
    writeChain = run.then(() => {}, () => {});
    return run;
  };

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

    async revoke(id) {
      const record = find(id);
      if (!record) throw notFoundError();
      if (record.revokedAt) return null;
      const tokens = record.secret ? decryptTokens(masterKey, record.id, record.secret) : null;
      record.revokedAt = new Date().toISOString();
      record.secret = null;
      await save();
      return tokens?.refreshToken ?? null;
    },

    withLock(id, fn) {
      const prev = locks.get(id) ?? Promise.resolve();
      const run = prev.then(() => fn());
      const tail = run.then(() => {}, () => {});
      locks.set(id, tail);
      tail.then(() => {
        if (locks.get(id) === tail) locks.delete(id);
      });
      return run;
    },

    flush() {
      return writeChain;
    },

    get size() {
      return records.filter((record) => !record.revokedAt).length;
    },
  };
}
