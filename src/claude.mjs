import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicError } from './security.mjs';

const ONE_MIB = 1024 * 1024;

export function buildCredentialPayload(tokens) {
  const oauth = {
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    scopes: Array.isArray(tokens.scopes) ? tokens.scopes : ['user:inference'],
  };
  if (tokens.refreshToken) oauth.refreshToken = tokens.refreshToken;
  if (tokens.subscriptionType) oauth.subscriptionType = tokens.subscriptionType;
  if (tokens.rateLimitTier) oauth.rateLimitTier = tokens.rateLimitTier;
  return { claudeAiOauth: oauth };
}

async function temporaryBase() {
  const preferred = '/dev/shm/claude-session-lab';
  try {
    const info = await stat('/dev/shm');
    if (!info.isDirectory()) throw new Error('not a directory');
    await access('/dev/shm', fsConstants.W_OK);
    await mkdir(preferred, { recursive: true, mode: 0o700 });
    await chmod(preferred, 0o700);
    return preferred;
  } catch {
    const fallback = join(tmpdir(), 'claude-session-lab');
    await mkdir(fallback, { recursive: true, mode: 0o700 });
    await chmod(fallback, 0o700);
    return fallback;
  }
}

function terminateProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function capture(stream, limit, onOverflow) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  stream.on('data', (chunk) => {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
    else if (!overflow) {
      overflow = true;
      onOverflow();
    }
  });
  return {
    get overflow() { return overflow; },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

function parseCliResult(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('Claude returned no JSON output');
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch {}
    }
    throw new Error('Claude returned malformed JSON output');
  }
}

async function readUpdatedTokens(path, original) {
  try {
    const raw = await readFile(path, { encoding: 'utf8' });
    if (raw.length > 128 * 1024) return original;
    const parsed = JSON.parse(raw)?.claudeAiOauth;
    if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.accessToken) return original;
    return {
      ...original,
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : original.refreshToken,
      expiresAt: Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : original.expiresAt,
      refreshTokenExpiresAt: Number.isFinite(parsed.refreshTokenExpiresAt)
        ? parsed.refreshTokenExpiresAt
        : original.refreshTokenExpiresAt,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes : original.scopes,
      subscriptionType: typeof parsed.subscriptionType === 'string'
        ? parsed.subscriptionType
        : original.subscriptionType,
      rateLimitTier: typeof parsed.rateLimitTier === 'string'
        ? parsed.rateLimitTier
        : original.rateLimitTier,
    };
  } catch {
    return original;
  }
}

function publicCliError(result) {
  const message = String(result?.result ?? '').toLowerCase();
  if (message.includes('not logged in') || message.includes('unauthorized') || result?.api_error_status === 401) {
    return new PublicError(401, 'CLAUDE_AUTH_REQUIRED', 'The test Claude session needs to be connected again.');
  }
  if (message.includes('rate limit') || result?.api_error_status === 429) {
    return new PublicError(429, 'CLAUDE_RATE_LIMITED', 'The test subscription is temporarily rate-limited. Try again later.');
  }
  return new PublicError(502, 'CLAUDE_INFERENCE_FAILED', 'Claude could not complete this prompt. Retry once, then reconnect if it continues.');
}

export async function runClaudePrompt({
  tokens,
  prompt,
  binary,
  timeoutMs = 120000,
  maxOutputBytes = 2 * ONE_MIB,
}) {
  const base = await temporaryBase();
  const root = await mkdtemp(join(base, 'run-'));
  const home = join(root, 'home');
  const config = join(root, 'config');
  const work = join(root, 'work');
  const credentialsPath = join(config, '.credentials.json');
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(config, { mode: 0o700 }),
    mkdir(work, { mode: 0o700 }),
  ]);
  await writeFile(credentialsPath, `${JSON.stringify(buildCredentialPayload(tokens))}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(credentialsPath, 0o600);

  const env = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    HOME: home,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  };

  let child;
  let timedOut = false;
  let outputOverflow = false;
  let hardKillTimer;
  try {
    child = spawn(binary, [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--tools', '',
    ], {
      cwd: work,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const stopForOverflow = () => {
      outputOverflow = true;
      terminateProcessGroup(child, 'SIGTERM');
    };
    const stdout = capture(child.stdout, maxOutputBytes, stopForOverflow);
    const stderr = capture(child.stderr, 256 * 1024, stopForOverflow);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child, 'SIGTERM');
      hardKillTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 2000);
      hardKillTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');

    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    clearTimeout(hardKillTimer);

    const updatedTokens = await readUpdatedTokens(credentialsPath, tokens);
    if (timedOut) throw new PublicError(504, 'CLAUDE_TIMEOUT', 'Claude took too long to respond. Try a shorter prompt.');
    if (outputOverflow || stdout.overflow || stderr.overflow) {
      throw new PublicError(502, 'CLAUDE_OUTPUT_LIMIT', 'Claude produced more output than this demo can safely display.');
    }
    if (outcome.code !== 0) {
      throw new PublicError(502, 'CLAUDE_PROCESS_FAILED', 'The isolated Claude process exited unexpectedly. Retry once.');
    }

    let result;
    try {
      result = parseCliResult(stdout.text());
    } catch {
      throw new PublicError(502, 'CLAUDE_RESPONSE_INVALID', 'Claude returned an unreadable response. Retry once.');
    }
    if (result?.is_error || result?.subtype !== 'success') throw publicCliError(result);

    const model = result.modelUsage && typeof result.modelUsage === 'object'
      ? Object.keys(result.modelUsage)[0] ?? null
      : null;
    const usage = result.usage && typeof result.usage === 'object' ? result.usage : {};

    return {
      response: {
        text: typeof result.result === 'string' ? result.result : '',
        model,
        durationMs: Number.isFinite(result.duration_ms) ? result.duration_ms : null,
        inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
        outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
      },
      updatedTokens,
    };
  } finally {
    if (child && child.exitCode === null) {
      terminateProcessGroup(child, 'SIGKILL');
    }
    clearTimeout(hardKillTimer);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
