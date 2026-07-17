import { fileURLToPath } from 'node:url';

const parsedPort = Number.parseInt(process.env.SESSION_LAB_PORT ?? '3210', 10);
if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
  throw new Error('SESSION_LAB_PORT must be an integer from 1024 through 65535');
}

export const APP_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: parsedPort,
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
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
});
