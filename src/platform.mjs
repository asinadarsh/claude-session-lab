// Every OS-specific decision lives here so the rest of the code stays platform-neutral.
// The functions take an explicit `platform` (and `exists`/`spawnImpl`) so the Windows and
// macOS paths are testable from any host.
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { PublicError } from './security.mjs';

// Path handling has to follow the TARGET platform, not the host: joining a Windows path with
// POSIX semantics yields C:\tools/claude.exe, which resolves nowhere.
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function platformLabel(platform = process.platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform;
}

async function pathExists(candidate) {
  try {
    await access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirs(env, platform) {
  const raw = env.PATH ?? env.Path ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  return raw.split(separator).filter(Boolean);
}

/**
 * Works out how to start the Claude CLI on this platform.
 *
 * Windows is the awkward one: a global npm install leaves `claude.cmd`, and Node cannot execute
 * a .cmd without a shell. Running it through a shell with caller-supplied arguments would be an
 * injection risk, so the preferred resolution is the CLI's own JavaScript entry point driven by
 * the current Node binary. cmd.exe is only a last resort, and by then every argument is either
 * a validated model name or a path this process created.
 */
export async function resolveClaudeCommand(binary, {
  platform = process.platform,
  env = process.env,
  exists = pathExists,
} = {}) {
  const requested = String(binary || 'claude');

  if (platform !== 'win32') {
    return { command: requested, prefixArgs: [], kind: 'direct' };
  }

  const win = pathFor(platform);
  const candidates = [];
  const hasSeparator = requested.includes('/') || requested.includes('\\');
  const addVariants = (base) => {
    if (win.extname(base)) {
      candidates.push(base);
      return;
    }
    for (const suffix of ['.exe', '.cmd', '.bat']) candidates.push(`${base}${suffix}`);
  };

  if (hasSeparator || win.extname(requested)) {
    addVariants(requested);
  } else {
    for (const dir of pathDirs(env, platform)) addVariants(win.join(dir, requested));
  }

  let resolved = null;
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      resolved = candidate;
      break;
    }
  }
  if (!resolved) {
    throw new PublicError(
      500,
      'CLAUDE_BINARY_MISSING',
      'The claude CLI could not be found. Set CLAUDE_BINARY to its full path, for example C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd',
    );
  }

  const extension = win.extname(resolved).toLowerCase();
  if (extension === '.exe') {
    return { command: resolved, prefixArgs: [], kind: 'exe' };
  }
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return { command: process.execPath, prefixArgs: [resolved], kind: 'node-script' };
  }

  // A .cmd/.bat shim: prefer the JavaScript entry it wraps so no shell is involved.
  const entry = win.join(win.dirname(resolved), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (await exists(entry)) {
    return { command: process.execPath, prefixArgs: [entry], kind: 'node-script' };
  }

  return {
    command: env.ComSpec ?? 'cmd.exe',
    prefixArgs: ['/d', '/s', '/c', resolved],
    kind: 'cmd-shim',
  };
}

/** Windows has no process groups, so the child's descendants need taskkill to go away. */
export function spawnDetached(platform = process.platform) {
  return platform !== 'win32';
}

export function terminateTree(child, signal, {
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  if (!child?.pid) return;
  if (platform === 'win32') {
    try {
      const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.on?.('error', () => {});
      killer.unref?.();
    } catch {}
    try { child.kill(); } catch {}
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

/**
 * Where request-scoped credential sandboxes are created. Linux gets tmpfs so the credential
 * never reaches a disk; elsewhere the OS temp directory is the only portable option and the
 * file is deleted as soon as the request ends.
 */
export async function sandboxBase({
  platform = process.platform,
  statImpl = stat,
  accessImpl = access,
  mkdirImpl = mkdir,
} = {}) {
  if (platform === 'linux') {
    try {
      const info = await statImpl('/dev/shm');
      if (!info.isDirectory()) throw new Error('not a directory');
      await accessImpl('/dev/shm', fsConstants.W_OK);
      const preferred = '/dev/shm/claude-session-lab';
      await mkdirImpl(preferred, { recursive: true, mode: 0o700 });
      return { base: preferred, backing: 'tmpfs' };
    } catch {}
  }
  const fallback = join(tmpdir(), 'claude-session-lab');
  await mkdirImpl(fallback, { recursive: true, mode: 0o700 });
  return { base: fallback, backing: platform === 'linux' ? 'disk' : 'os-temp' };
}

export function defaultCredentialsPath({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.CLAUDE_CREDENTIALS) return env.CLAUDE_CREDENTIALS;
  const target = pathFor(platform);
  const configDir = env.CLAUDE_CONFIG_DIR ?? target.join(home, '.claude');
  return target.join(configDir, '.credentials.json');
}

function runCapture(spawnImpl, command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch {
      resolve({ ok: false, stdout: '' });
      return;
    }
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 128 * 1024) stdout += chunk;
    });
    child.stderr?.resume?.();
    child.on('error', () => resolve({ ok: false, stdout: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout }));
  });
}

// Which Keychain entry holds the CLI's credentials is not a documented contract, so rather than
// betting on one name these are tried in order. CLAUDE_KEYCHAIN_SERVICE overrides the list for
// anyone whose install uses something else again.
export const KEYCHAIN_SERVICE_CANDIDATES = Object.freeze([
  'Claude Code-credentials',
  'Claude Code',
  'claude-code-credentials',
]);

export function keychainServices(env = process.env) {
  const override = env.CLAUDE_KEYCHAIN_SERVICE;
  if (typeof override === 'string' && override.trim()) return [override.trim()];
  return [...KEYCHAIN_SERVICE_CANDIDATES];
}

/**
 * Turns whatever `security -w` printed into an OAuth object.
 * Two shapes are tolerated because neither is guaranteed: the payload may be the full
 * `{claudeAiOauth: {...}}` wrapper or the bare object, and `security` prints hex rather than text
 * when the stored bytes are not printable.
 */
export function decodeKeychainPayload(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const forms = [text];
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
    forms.push(Buffer.from(text, 'hex').toString('utf8'));
  }
  for (const form of forms) {
    try {
      const parsed = JSON.parse(form);
      const oauth = parsed?.claudeAiOauth ?? parsed;
      if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken) return oauth;
    } catch {}
  }
  return null;
}

/**
 * Reads the credentials of the Claude CLI signed in on this machine.
 * macOS keeps them in the login Keychain rather than on disk, so that is tried first there.
 */
export async function readLocalClaudeCredentials({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  readFileImpl = readFile,
  spawnImpl = spawn,
} = {}) {
  const attempts = [];
  const explicit = Boolean(env.CLAUDE_CREDENTIALS);
  const filePath = defaultCredentialsPath({ platform, env, home });

  if (platform === 'darwin' && !explicit) {
    const services = keychainServices(env);
    for (const service of services) {
      const keychain = await runCapture(spawnImpl, 'security', [
        'find-generic-password', '-s', service, '-w',
      ]);
      if (!keychain.ok || !keychain.stdout.trim()) continue;
      const oauth = decodeKeychainPayload(keychain.stdout);
      if (oauth) {
        return { source: `macOS Keychain (service "${service}")`, sourceKind: 'keychain', oauth };
      }
      attempts.push(`the Keychain entry "${service}" held data this version could not parse`);
    }
    attempts.push(`no readable Keychain entry among ${services.map((name) => `"${name}"`).join(', ')}`);
  }

  try {
    const raw = await readFileImpl(filePath, 'utf8');
    return { source: filePath, sourceKind: 'file', oauth: JSON.parse(raw)?.claudeAiOauth };
  } catch (error) {
    attempts.push(`${filePath} could not be read (${error.code ?? 'unreadable'})`);
  }

  const detail = attempts.join('; ');
  const hint = platform === 'darwin'
    ? 'On macOS the CLI stores credentials in the login Keychain; approve the access prompt, set CLAUDE_KEYCHAIN_SERVICE to the entry name, or link through the browser flow instead.'
    : 'Run `claude` and sign in first, or set CLAUDE_CREDENTIALS to the file holding them.';
  throw new PublicError(500, 'LOCAL_CREDENTIALS_UNAVAILABLE', `${detail}. ${hint}`);
}
