import { fileURLToPath } from 'node:url';

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean value`);
}

const port = intEnv('SESSION_LAB_PORT', 3210, 1024, 65535);
const gatewayEnabled = boolEnv('SESSION_LAB_GATEWAY', false);
const masterKey = process.env.SESSION_LAB_MASTER_KEY ?? '';

if (gatewayEnabled && !masterKey) {
  throw new Error('SESSION_LAB_GATEWAY=1 requires SESSION_LAB_MASTER_KEY (generate with: openssl rand -base64 32)');
}

const host = process.env.SESSION_LAB_HOST ?? '127.0.0.1';
if (!/^[0-9a-fA-F:.]+$/.test(host)) throw new Error('SESSION_LAB_HOST must be an IP address');
if (host !== '127.0.0.1' && host !== '::1' && !boolEnv('SESSION_LAB_ALLOW_PUBLIC_BIND', false)) {
  throw new Error('Binding off-localhost requires SESSION_LAB_ALLOW_PUBLIC_BIND=1; prefer a reverse proxy that exposes only /v1/*');
}

export const APP_CONFIG = Object.freeze({
  host,
  port,
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
  dataDir: fileURLToPath(new URL('../data/', import.meta.url)),
  keystoreFile: process.env.SESSION_LAB_KEYSTORE
    ?? fileURLToPath(new URL('../data/keystore.json', import.meta.url)),
  claudeBinary: process.env.CLAUDE_BINARY ?? 'claude',
  sessionCookie: 'csl_session',
  sessionTtlMs: 12 * 60 * 60 * 1000,
  oauthTtlMs: 10 * 60 * 1000,
  maxSessions: 64,
  maxJsonBytes: 24 * 1024,
  maxAuthorizationCodeChars: 8192,
  maxPromptChars: 12000,
  oauthTimeoutMs: 30000,
  profileTimeoutMs: 10000,
  revokeTimeoutMs: 5000,
  claudeTimeoutMs: 120000,
  maxClaudeOutputBytes: 2 * 1024 * 1024,

  gateway: Object.freeze({
    enabled: gatewayEnabled,
    masterKey,
    trustProxy: boolEnv('SESSION_LAB_TRUST_PROXY', false),
    corsOrigins: (process.env.SESSION_LAB_CORS_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    maxConnections: intEnv('SESSION_LAB_MAX_CONNECTIONS', 16, 1, 256),
    maxBodyBytes: intEnv('SESSION_LAB_MAX_BODY_KB', 8192, 8, 32768) * 1024,
    maxPromptChars: intEnv('SESSION_LAB_MAX_PROMPT_CHARS', 400000, 1000, 4000000),
    maxMessages: intEnv('SESSION_LAB_MAX_MESSAGES', 200, 1, 2000),
    maxImages: intEnv('SESSION_LAB_MAX_IMAGES', 6, 0, 32),
    maxImageBytes: intEnv('SESSION_LAB_MAX_IMAGE_KB', 3600, 32, 16384) * 1024,
    requestTimeoutMs: intEnv('SESSION_LAB_REQUEST_TIMEOUT_S', 600, 30, 3600) * 1000,
    queueLimit: intEnv('SESSION_LAB_QUEUE_LIMIT', 4, 1, 64),
    rateLimitPerMinute: intEnv('SESSION_LAB_RATE_LIMIT_PER_MINUTE', 60, 1, 6000),
    defaultMaxTokens: intEnv('SESSION_LAB_DEFAULT_MAX_TOKENS', 4096, 256, 64000),
  }),
});
