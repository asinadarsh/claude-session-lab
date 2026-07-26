#!/usr/bin/env node
// Links the Claude account already signed in to Claude Code on THIS machine and prints one
// gateway key. Convenience path for a single-owner self-host; the browser PKCE flow in the
// admin UI is the right choice when the gateway account should stay separate.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_CONFIG } from '../src/config.mjs';
import { openKeystore, parseMasterKey } from '../src/keystore.mjs';
import { fetchOAuthProfile } from '../src/oauth.mjs';

const label = process.argv[2] ?? 'local-claude-code';
const credentialsPath = process.env.CLAUDE_CREDENTIALS
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');

function fail(message) {
  console.error(`link-local: ${message}`);
  process.exit(1);
}

if (!APP_CONFIG.gateway.masterKey) {
  fail('SESSION_LAB_MASTER_KEY is required. Generate one with: openssl rand -base64 32');
}

let oauth;
try {
  const raw = await readFile(credentialsPath, 'utf8');
  oauth = JSON.parse(raw)?.claudeAiOauth;
} catch (error) {
  fail(`could not read ${credentialsPath} (${error.code ?? 'unreadable'}). Run \`claude\` and sign in first.`);
}
if (!oauth?.accessToken) fail(`no claudeAiOauth.accessToken in ${credentialsPath}`);
if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt < Date.now() && !oauth.refreshToken) {
  fail('the stored access token is expired and there is no refresh token. Run `claude` to sign in again.');
}

const tokens = {
  accessToken: oauth.accessToken,
  refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : null,
  expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : Date.now() + 3600000,
  refreshTokenExpiresAt: Number.isFinite(oauth.refreshTokenExpiresAt)
    ? oauth.refreshTokenExpiresAt
    : Date.now() + 365 * 24 * 60 * 60 * 1000,
  scopes: Array.isArray(oauth.scopes) ? oauth.scopes : ['user:inference'],
  subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
  rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
  tokenAccount: {},
};

let profile = null;
try {
  profile = await fetchOAuthProfile(tokens.accessToken, { timeoutMs: APP_CONFIG.profileTimeoutMs });
  if (profile?.subscriptionType) tokens.subscriptionType = profile.subscriptionType;
  if (profile?.rateLimitTier) tokens.rateLimitTier = profile.rateLimitTier;
  if (profile?.emailAddress) tokens.tokenAccount.emailAddress = profile.emailAddress;
} catch {
  console.error('link-local: could not read the account profile; continuing without plan metadata.');
}

let keystore;
try {
  keystore = await openKeystore({
    file: APP_CONFIG.keystoreFile,
    masterKey: parseMasterKey(APP_CONFIG.gateway.masterKey),
  });
} catch (error) {
  fail(error.publicMessage ?? error.message);
}
const { connection, apiKey } = await keystore.createConnection({ label, tokens, profile });
await keystore.close();

console.log(`Linked ${connection.account.emailMasked ?? 'account'} (${connection.account.plan ?? 'plan unknown'}) as "${connection.label}".`);
console.log(`Keystore: ${APP_CONFIG.keystoreFile}`);
console.log('');
console.log('Gateway key (shown once, store it now):');
console.log(apiKey);
console.log('');
console.log('This copies the refresh token that Claude Code on this machine also uses. When either');
console.log('side refreshes, the other may need to sign in again; link a separate account to avoid it.');
