import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class PublicError extends Error {
  constructor(status, code, publicMessage) {
    super(publicMessage);
    this.name = 'PublicError';
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

export function randomToken(bytes = 32) {
  return base64Url(randomBytes(bytes));
}

export function createPkce() {
  const verifier = randomToken(32);
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function sessionCookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function expiredCookie(name) {
  return `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  const visible = local.length > 1 ? local.slice(0, 2) : local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(3, Math.min(8, local.length - visible.length)))}@${domain}`;
}

export function redactSecrets(value, maxLength = 800) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/("(?:access_token|refresh_token|accessToken|refreshToken|code_verifier|authorizationCode)"\s*:\s*")[^"]+/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|accessToken|refreshToken|code_verifier|authorizationCode)\s*[=:]\s*)[^\s,;}]+/gi, '$1[REDACTED]')
    .slice(0, maxLength);
}

function parseUrlLike(value) {
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    return {
      code: parsed.searchParams.get('code') ?? fragment.get('code'),
      state: parsed.searchParams.get('state') ?? fragment.get('state'),
    };
  }

  if (/^(?:code|state)=/i.test(value) && value.includes('=')) {
    const parsed = new URLSearchParams(value.replace(/^\?/, '').replace(/^#/, ''));
    return { code: parsed.get('code'), state: parsed.get('state') };
  }

  return null;
}

export function parseManualAuthorization(input, expectedState, maxChars = 8192) {
  if (typeof input !== 'string') {
    throw new PublicError(400, 'AUTH_CODE_REQUIRED', 'Paste the authorization code to continue.');
  }

  const value = input.trim();
  if (!value || value.length > maxChars) {
    throw new PublicError(400, 'AUTH_CODE_INVALID', 'The authorization code is missing or too long. Start again and paste the new code.');
  }

  let code = value;
  let suppliedState = null;

  try {
    const parsed = parseUrlLike(value);
    if (parsed?.code) {
      code = parsed.code;
      suppliedState = parsed.state;
    } else if (!parsed) {
      const hashIndex = value.lastIndexOf('#');
      if (hashIndex > 0) {
        const possibleState = value.slice(hashIndex + 1);
        if (/^[A-Za-z0-9_-]{32,128}$/.test(possibleState)) {
          code = value.slice(0, hashIndex);
          suppliedState = possibleState;
        }
      }
    }
  } catch {
    throw new PublicError(400, 'AUTH_CODE_INVALID', 'The pasted authorization value is not valid. Copy the code again and retry.');
  }

  if (suppliedState && !constantTimeEqual(suppliedState, expectedState)) {
    throw new PublicError(400, 'AUTH_STATE_MISMATCH', 'This code belongs to a different sign-in attempt. Start a new authorization.');
  }

  code = String(code ?? '').trim();
  if (!code || code.length > 4096 || /[\u0000-\u001f\u007f\s]/.test(code)) {
    throw new PublicError(400, 'AUTH_CODE_INVALID', 'The pasted authorization code has an invalid format. Copy it again without extra spaces.');
  }

  return code;
}
