import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicError } from './security.mjs';

const ONE_MIB = 1024 * 1024;

// Sent when the caller supplies no system prompt. Passing --system-prompt replaces the
// Claude Code agent preamble, which keeps API behaviour close to the Messages API and
// avoids billing the caller for a coding-agent system prompt they never asked for.
export const DEFAULT_SYSTEM_PROMPT = 'You are Claude, a helpful AI assistant. Answer the user directly.';

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

export function buildUserLine(text) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
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

// stdout is JSONL; deliver one parsed object per line and drop anything unparseable
// rather than failing the whole run on a stray log line.
function lineReader(stream, limit, onLine, onOverflow) {
  let buffer = '';
  let size = 0;
  let overflow = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      if (!overflow) {
        overflow = true;
        onOverflow();
      }
      return;
    }
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          onLine(JSON.parse(line));
        } catch {}
      }
      index = buffer.indexOf('\n');
    }
    if (buffer.length > ONE_MIB) buffer = '';
  });
  stream.on('end', () => {
    const line = buffer.trim();
    buffer = '';
    if (!line) return;
    try {
      onLine(JSON.parse(line));
    } catch {}
  });
  return { get overflow() { return overflow; } };
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

export function publicCliError(result) {
  const message = String(result?.result ?? '').toLowerCase();
  if (message.includes('not logged in') || message.includes('unauthorized') || result?.api_error_status === 401) {
    return new PublicError(401, 'CLAUDE_AUTH_REQUIRED', 'The linked Claude account needs to be connected again.');
  }
  if (message.includes('rate limit') || message.includes('usage limit') || result?.api_error_status === 429) {
    return new PublicError(429, 'CLAUDE_RATE_LIMITED', 'The linked Claude subscription is rate-limited. Try again later.');
  }
  if (result?.api_error_status === 400 || message.includes('too long') || message.includes('exceed')) {
    return new PublicError(400, 'CLAUDE_REQUEST_REJECTED', 'Claude rejected this request. Shorten the conversation and retry.');
  }
  return new PublicError(502, 'CLAUDE_INFERENCE_FAILED', 'Claude could not complete this request. Retry once, then reconnect if it continues.');
}

/**
 * Runs one sandboxed `claude` turn and streams every stdout JSONL object to onEvent.
 * The sandbox (temporary HOME, CLAUDE_CONFIG_DIR and credentials file) is destroyed
 * before this resolves, whatever the outcome.
 */
export async function runClaudeStream({
  tokens,
  cliInputLine,
  model = 'sonnet',
  systemPrompt = null,
  maxTokens = null,
  binary,
  timeoutMs = 120000,
  maxOutputBytes = 2 * ONE_MIB,
  onEvent = () => {},
  signal = null,
}) {
  if (typeof cliInputLine !== 'string' || !cliInputLine || cliInputLine.includes('\n')) {
    throw new PublicError(500, 'CLI_INPUT_INVALID', 'The request could not be prepared for the inference sandbox.');
  }

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
    DISABLE_AUTOUPDATER: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  if (Number.isInteger(maxTokens) && maxTokens > 0) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
  }

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools', '',
    '--model', model,
    '--system-prompt', systemPrompt || DEFAULT_SYSTEM_PROMPT,
  ];

  let child;
  let timedOut = false;
  let aborted = false;
  let outputOverflow = false;
  let hardKillTimer;
  let onAbort;
  try {
    child = spawn(binary, args, {
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
    const stdout = lineReader(child.stdout, maxOutputBytes, (obj) => {
      try {
        onEvent(obj);
      } catch {}
    }, stopForOverflow);
    const stderr = capture(child.stderr, 256 * 1024, stopForOverflow);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child, 'SIGTERM');
      hardKillTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 2000);
      hardKillTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        terminateProcessGroup(child, 'SIGTERM');
      } else {
        onAbort = () => {
          aborted = true;
          terminateProcessGroup(child, 'SIGTERM');
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdin.on('error', () => {});
    child.stdin.end(`${cliInputLine}\n`, 'utf8');

    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signalName) => resolve({ code, signal: signalName }));
    });
    clearTimeout(timer);
    clearTimeout(hardKillTimer);

    const updatedTokens = await readUpdatedTokens(credentialsPath, tokens);
    if (aborted) return { updatedTokens, aborted: true, exitCode: outcome.code };
    if (timedOut) throw new PublicError(504, 'CLAUDE_TIMEOUT', 'Claude took too long to respond. Try a shorter request.');
    if (outputOverflow || stdout.overflow || stderr.overflow) {
      throw new PublicError(502, 'CLAUDE_OUTPUT_LIMIT', 'Claude produced more output than this gateway allows.');
    }
    if (outcome.code !== 0) {
      throw new PublicError(502, 'CLAUDE_PROCESS_FAILED', 'The isolated Claude process exited unexpectedly. Retry once.');
    }
    return { updatedTokens, aborted: false, exitCode: outcome.code };
  } catch (error) {
    if (error instanceof PublicError) throw error;
    if (error?.code === 'ENOENT') {
      throw new PublicError(500, 'CLAUDE_BINARY_MISSING', 'The claude CLI could not be started. Check CLAUDE_BINARY.');
    }
    throw new PublicError(502, 'CLAUDE_PROCESS_FAILED', 'The isolated Claude process could not be started. Retry once.');
  } finally {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    if (child && child.exitCode === null) terminateProcessGroup(child, 'SIGKILL');
    clearTimeout(hardKillTimer);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** One-shot text prompt used by the browser demo. */
export async function runClaudePrompt({
  tokens,
  prompt,
  binary,
  model = 'sonnet',
  systemPrompt = null,
  timeoutMs = 120000,
  maxOutputBytes = 2 * ONE_MIB,
}) {
  let assistantMessage = null;
  let result = null;
  const { updatedTokens } = await runClaudeStream({
    tokens,
    cliInputLine: buildUserLine(prompt),
    model,
    systemPrompt,
    binary,
    timeoutMs,
    maxOutputBytes,
    onEvent: (obj) => {
      if (obj?.type === 'assistant' && obj.message) assistantMessage = obj.message;
      else if (obj?.type === 'result') result = obj;
    },
  });

  if (!result) throw new PublicError(502, 'CLAUDE_RESPONSE_INVALID', 'Claude returned an unreadable response. Retry once.');
  if (result.is_error || result.subtype !== 'success') throw publicCliError(result);

  const blocks = Array.isArray(assistantMessage?.content) ? assistantMessage.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    || (typeof result.result === 'string' ? result.result : '');
  const usage = result.usage && typeof result.usage === 'object' ? result.usage : {};

  return {
    response: {
      text,
      model: typeof assistantMessage?.model === 'string'
        ? assistantMessage.model
        : (result.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage)[0] ?? null : null),
      durationMs: Number.isFinite(result.duration_ms) ? result.duration_ms : null,
      inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
      outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
    },
    updatedTokens,
  };
}
