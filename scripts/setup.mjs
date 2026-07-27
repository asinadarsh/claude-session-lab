#!/usr/bin/env node
// Interactive installer: replaces the manual env-var dance with one guided run.
// Everything OS-specific is either delegated to src/platform.mjs or rendered by a pure
// function that takes `platform` explicitly, so the Windows and macOS output is testable
// from any host. The interactive main only runs when this file is the entry point.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path, { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platformLabel, readLocalClaudeCredentials, resolveClaudeCommand } from '../src/platform.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const MIN_NODE_MAJOR = 24;
const SERVICE_NAME = 'claude-session-lab';
const LAUNCHD_LABEL = 'com.claude-session-lab.gateway';

export const DEFAULT_PORT = 3210;

const USAGE = `Claude Session Lab setup

  node scripts/setup.mjs [--yes] [--help]

  --yes, -y   non-interactive: take every default, never prompt, never write a
              service file, and never touch an existing keystore
  --help, -h  print this and exit

Writes data/gateway.env (mode 0600) holding SESSION_LAB_GATEWAY, SESSION_LAB_MASTER_KEY,
CLAUDE_BINARY and SESSION_LAB_PORT, then optionally links an account and issues one
csl_sk_... gateway key.`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for test/setup.test.mjs)
// ---------------------------------------------------------------------------

/** Returns the port number, `fallback` for empty input, or null when invalid. */
export function parsePort(raw, fallback = DEFAULT_PORT) {
  if (raw === undefined || raw === null) return fallback;
  const text = String(raw).trim();
  if (text === '') return fallback;
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1024 && port <= 65535 ? port : null;
}

/**
 * Renders data/gateway.env. Values are deliberately unquoted: Node's --env-file parser
 * takes everything after the first `=` verbatim, which keeps base64 (`+/=`) and Windows
 * paths (backslashes, spaces) intact. Quoting them would be wrong, not safer.
 */
export function renderConfig({ masterKey, claudeBinary, port = DEFAULT_PORT }) {
  for (const [name, value] of [['masterKey', masterKey], ['claudeBinary', claudeBinary]]) {
    if (typeof value !== 'string' || value === '') throw new Error(`renderConfig: ${name} is required`);
    if (/[\r\n]/.test(value)) throw new Error(`renderConfig: ${name} must not contain a newline`);
  }
  const validPort = parsePort(port);
  if (validPort === null) throw new Error('renderConfig: port must be 1024-65535');
  return [
    '# Written by scripts/setup.mjs. Contains a secret: keep it at mode 0600, never commit it.',
    '# Load it with: node --env-file-if-exists=data/gateway.env src/server.mjs',
    '# A variable already set in your shell wins over this file.',
    'SESSION_LAB_GATEWAY=1',
    `SESSION_LAB_MASTER_KEY=${masterKey}`,
    `CLAUDE_BINARY=${claudeBinary}`,
    `SESSION_LAB_PORT=${validPort}`,
    '',
  ].join('\n');
}

/** Minimal KEY=VALUE reader for a file this script wrote. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Pulls the one-time gateway key out of link-local's stdout. */
export function extractApiKey(output) {
  const match = String(output ?? '').match(/csl_sk_[A-Za-z0-9_-]{16,}/);
  return match ? match[0] : null;
}

// Paths rendered FOR a platform must use that platform's separator, not the host's: a systemd
// unit path built on Windows with the host separator comes out as \home\you\... and is wrong.
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Ordered places the claude CLI is plausibly installed, most explicit first. */
export function claudeCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const out = [];
  const push = (candidate) => {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  };
  if (env.CLAUDE_BINARY) push(env.CLAUDE_BINARY);
  const target = pathFor(platform);
  const names = platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude.bat'] : ['claude'];
  const separator = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH ?? env.Path ?? '').split(separator).filter(Boolean)) {
    for (const name of names) push(target.join(dir, name));
  }
  if (platform === 'win32') {
    if (env.APPDATA) push(target.join(env.APPDATA, 'npm', 'claude.cmd'));          // npm -g shim
    if (env.LOCALAPPDATA) {
      push(target.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
      push(target.join(env.LOCALAPPDATA, 'Programs', 'claude-code', 'claude.exe'));
    }
    push(target.join(home, '.local', 'bin', 'claude.exe'));
  } else {
    push(target.join(home, '.local', 'bin', 'claude'));            // official install script
    push(target.join(home, '.claude', 'local', 'claude'));         // `claude migrate-installer`
    if (platform === 'darwin') push('/opt/homebrew/bin/claude');
    push('/usr/local/bin/claude');
    push('/usr/bin/claude');
  }
  return out;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function serverArgs(repoRoot, envFile, target = path) {
  return [`--env-file-if-exists=${envFile}`, target.join(repoRoot, 'src', 'server.mjs')];
}

/** Renders the per-OS "keep it running" file. Returns null for platforms we will not guess at. */
export function renderServiceFile({
  platform = process.platform,
  execPath = process.execPath,
  repoRoot = REPO_ROOT,
  home = homedir(),
  port = DEFAULT_PORT,
} = {}) {
  const target = pathFor(platform);
  const root = repoRoot.replace(/[\\/]$/, '');
  const envFile = target.join(root, 'data', 'gateway.env');
  const args = serverArgs(root, envFile, target);

  if (platform === 'linux') {
    const quoted = [execPath, ...args].map((part) => `"${part}"`).join(' ');
    return {
      kind: 'systemd --user unit',
      path: target.join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`),
      contents: [
        '[Unit]',
        `Description=Claude Session Lab gateway (127.0.0.1:${port})`,
        'After=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        `WorkingDirectory=${root}`,
        '# Absolute node path on purpose: the systemd user manager never sees nvm/fnm PATH shims.',
        `ExecStart=${quoted}`,
        'Restart=on-failure',
        'RestartSec=5',
        '# The master key stays in the 0600 env file above; it is never inlined here.',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
      commands: [
        'systemctl --user daemon-reload',
        `systemctl --user enable --now ${SERVICE_NAME}.service`,
        'loginctl enable-linger "$USER"   # keep it running after you log out',
        `journalctl --user -u ${SERVICE_NAME}.service -f   # logs`,
      ],
      note: 'Without enable-linger the unit stops when your last session ends.',
    };
  }

  if (platform === 'darwin') {
    const plistPath = target.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const logDir = target.join(root, 'logs');
    return {
      kind: 'launchd agent',
      path: plistPath,
      logDir,
      contents: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        `  <string>${LAUNCHD_LABEL}</string>`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...[execPath, ...args].map((part) => `    <string>${xmlEscape(part)}</string>`),
        '  </array>',
        '  <key>WorkingDirectory</key>',
        `  <string>${xmlEscape(root)}</string>`,
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>KeepAlive</key>',
        '  <true/>',
        '  <key>StandardOutPath</key>',
        `  <string>${xmlEscape(target.join(logDir, 'gateway.out.log'))}</string>`,
        '  <key>StandardErrorPath</key>',
        `  <string>${xmlEscape(target.join(logDir, 'gateway.err.log'))}</string>`,
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
      commands: [
        `launchctl load -w ${plistPath}`,
        `launchctl unload ${plistPath}   # stop it`,
        `tail -f ${target.join(logDir, 'gateway.err.log')}   # logs`,
      ],
      note: 'launchd needs the log directory to exist; setup creates logs/ when it writes the plist.',
    };
  }

  if (platform === 'win32') {
    const launcher = target.join(root, 'data', 'start-gateway.cmd');
    return {
      kind: 'logon scheduled task (no service wrapper)',
      path: launcher,
      contents: [
        '@echo off',
        'REM Written by scripts/setup.mjs. Starts the gateway using data\\gateway.env.',
        `cd /d "${root}"`,
        `"${execPath}" "${args[0]}" "${args[1]}"`,
        '',
      ].join('\r\n'),
      commands: [
        `schtasks /create /tn "${SERVICE_NAME}" /sc onlogon /rl limited /tr "\\"${launcher}\\""`,
        `schtasks /run /tn "${SERVICE_NAME}"      # start it now`,
        `schtasks /delete /tn "${SERVICE_NAME}" /f   # remove it`,
      ],
      note: 'Windows has no first-party Node service wrapper, so this stays a scheduled task. '
        + 'Run it any other way and closing the terminal stops the server.',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Interactive plumbing
// ---------------------------------------------------------------------------

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

async function exists(target, mode = fsConstants.F_OK) {
  try {
    await access(target, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompt wrapper that can never throw ERR_USE_AFTER_CLOSE: piped/closed stdin and Ctrl-D
 * fall back to the default forever after, and Ctrl-C exits before anything is written.
 */
function createPrompter({ auto = false } = {}) {
  if (auto) {
    return { auto: true, ask: async (_q, fallback = '') => fallback, confirm: async (_q, fallback = false) => fallback, close() {} };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  // Piped stdin arrives as one burst and readline fires every 'line' immediately, so the
  // lines are queued here; rl.question() alone would drop the ones nobody was awaiting yet.
  const queued = [];
  let waiting = null;
  let closed = false;
  let announced = false;
  const handOff = (line) => {
    if (!waiting) return false;
    const deliver = waiting;
    waiting = null;
    deliver(line);
    return true;
  };
  rl.on('line', (line) => {
    if (!handOff(line)) queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    handOff(null);
  });
  rl.on('SIGINT', () => {
    say('');
    say('[!] cancelled.');
    rl.close();
    process.exit(130);
  });

  const prompter = {
    auto: false,
    async ask(question, fallback = '') {
      const prompt = `${question}${fallback === '' ? '' : ` [${fallback}]`} `;
      let answer;
      if (queued.length > 0) {
        answer = queued.shift();
        process.stdout.write(`${prompt}${answer}\n`);
      } else if (closed) {
        answer = null;
      } else {
        process.stdout.write(prompt);
        answer = await new Promise((deliver) => { waiting = deliver; });
      }
      if (answer === null) {
        if (!announced) {
          announced = true;
          say('');
          say('[!] stdin closed - taking defaults from here on.');
        }
        return fallback;
      }
      const trimmed = answer.trim();
      return trimmed === '' ? fallback : trimmed;
    },
    async confirm(question, fallback = false) {
      const answer = await prompter.ask(`${question} ${fallback ? '(Y/n)' : '(y/N)'}`, fallback ? 'y' : 'n');
      return /^y(es)?$/i.test(answer);
    },
    close() {
      if (!closed) rl.close();
    },
  };
  return prompter;
}

function portFree(port, host = '127.0.0.1') {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, host);
  });
}

async function findClaude({ platform = process.platform, env = process.env } = {}) {
  const mode = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  for (const candidate of claudeCandidates({ platform, env })) {
    if (await exists(candidate, mode)) {
      return isAbsolute(candidate) ? candidate : resolve(candidate);
    }
  }
  return null;
}

function runCapture(command, args, env) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => done({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

function curlCommand({ platform, port, apiKey }) {
  const key = apiKey ?? 'csl_sk_YOUR_KEY';
  const url = `http://127.0.0.1:${port}/v1/messages`;
  const body = '{"model":"claude-sonnet-5","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}';
  if (platform === 'win32') {
    return `curl.exe -s ${url} -H "x-api-key: ${key}" -H "content-type: application/json" -d "${body.replace(/"/g, '\\"')}"`;
  }
  return `curl -s ${url} -H "x-api-key: ${key}" -H 'content-type: application/json' -d '${body}'`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv = process.argv) {
  const flags = argv.slice(2);
  if (flags.includes('--help') || flags.includes('-h')) {
    say(USAGE);
    return 0;
  }
  const auto = flags.includes('--yes') || flags.includes('-y');
  for (const flag of flags) {
    if (!['--yes', '-y', '--help', '-h'].includes(flag)) say(`[!] ignoring unknown argument: ${flag}`);
  }

  const platform = process.platform;
  const dataDir = join(REPO_ROOT, 'data');
  const configFile = join(dataDir, 'gateway.env');
  const keystoreFile = process.env.SESSION_LAB_KEYSTORE ?? join(dataDir, 'keystore.json');

  // 1. Preflight ------------------------------------------------------------
  say('Claude Session Lab setup');
  say('========================');
  say(`  OS       : ${platformLabel(platform)} (${platform}/${process.arch})`);
  say(`  Node     : ${process.version}  ${process.execPath}`);
  say(`  Repo     : ${REPO_ROOT}`);
  say(`  Mode     : ${auto ? 'non-interactive (--yes)' : 'interactive'}`);
  say('');

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    say(`[x] Node ${MIN_NODE_MAJOR} or newer is required (found ${process.version}).`);
    say('    This project uses node: builtins and --env-file-if-exists that older releases lack.');
    say('    -> Install Node 24 LTS from https://nodejs.org or via nvm: nvm install 24 && nvm use 24');
    return 1;
  }
  say(`[ok] Node ${process.version} meets the >=${MIN_NODE_MAJOR} requirement.`);

  const binaryPath = await findClaude({ platform });
  if (!binaryPath) {
    say('[x] The claude CLI was not found.');
    say('    Looked at: CLAUDE_BINARY, every PATH entry, and the usual install locations:');
    for (const candidate of claudeCandidates({ platform }).slice(-4)) say(`      ${candidate}`);
    say('    -> Install it:  npm install -g @anthropic-ai/claude-code');
    say('    -> Then sign in once:  claude');
    say('    -> Installed somewhere unusual? Re-run with CLAUDE_BINARY=/full/path/to/claude');
    return 1;
  }
  let resolved;
  try {
    resolved = await resolveClaudeCommand(binaryPath, { platform });
  } catch (error) {
    say(`[x] ${error.publicMessage ?? error.message}`);
    return 1;
  }
  say(`[ok] claude CLI  : ${binaryPath}`);
  say(`     launch kind : ${resolved.kind}${resolved.prefixArgs.length ? ` via ${resolved.command}` : ''}`);
  say('');

  const prompter = createPrompter({ auto });
  try {
    // 2. Existing install -------------------------------------------------
    const haveKeystore = await exists(keystoreFile);
    const haveConfig = await exists(configFile);
    const existingConfig = haveConfig ? parseEnvFile(await readFile(configFile, 'utf8')) : {};
    let masterKey = '';
    let masterKeyIsNew = false;

    if (haveKeystore) {
      say(`[!] A keystore already exists: ${keystoreFile}`);
      say('    Its OAuth tokens are encrypted with the master key you generated the first time.');
      say('    A new master key would strand every one of them, so setup will not generate one.');
      masterKey = existingConfig.SESSION_LAB_MASTER_KEY || process.env.SESSION_LAB_MASTER_KEY || '';
      if (masterKey) {
        say(`[ok] Reusing the existing master key from ${haveConfig && existingConfig.SESSION_LAB_MASTER_KEY ? configFile : 'SESSION_LAB_MASTER_KEY in your shell'}.`);
      }
      if (auto) {
        say('[!] --yes will not modify an existing install. Nothing was written.');
        say('    Re-run without --yes to add another API key to this keystore.');
        return 0;
      }
      if (!await prompter.confirm('Keep the existing master key and just add a new API key?', true)) {
        say('[!] Aborted at your request. Nothing was written.');
        return 0;
      }
      if (!masterKey) {
        say('    The master key is not in data/gateway.env or your shell, so it has to be pasted.');
        masterKey = await prompter.ask('Paste SESSION_LAB_MASTER_KEY (base64 32 bytes, or 64-char hex):', '');
        if (!masterKey) {
          say('[x] Without the original master key the stored tokens cannot be decrypted');
          say('    (the server would fail with KEYSTORE_UNREADABLE). Nothing was written.');
          say(`    Lost it for good? Delete ${keystoreFile} and re-run to start over.`);
          return 1;
        }
      }
    } else if (existingConfig.SESSION_LAB_MASTER_KEY) {
      masterKey = existingConfig.SESSION_LAB_MASTER_KEY;
      say(`[ok] Reusing the master key already in ${configFile} (no keystore exists yet).`);
    }

    // 3. Master key --------------------------------------------------------
    if (!masterKey) {
      masterKey = randomBytes(32).toString('base64');
      masterKeyIsNew = true;
      say('[ok] Generated a fresh 32-byte master key.');
    }
    say('');

    // 4. Port --------------------------------------------------------------
    const defaultPort = parsePort(existingConfig.SESSION_LAB_PORT ?? process.env.SESSION_LAB_PORT) ?? DEFAULT_PORT;
    let port = defaultPort;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const answer = await prompter.ask('Port for the gateway (1024-65535):', String(port));
      const parsed = parsePort(answer);
      if (parsed === null) {
        say('[!] Not a port in 1024-65535. Try again.');
        continue;
      }
      port = parsed;
      if (await portFree(port)) break;
      say(`[!] Port ${port} is already in use on 127.0.0.1.`);
      if (prompter.auto) {
        let next = null;
        for (let probe = port + 1; probe <= Math.min(port + 20, 65535); probe += 1) {
          if (await portFree(probe)) { next = probe; break; }
        }
        if (!next) {
          say('[x] No free port found near the default. Free one up and re-run.');
          return 1;
        }
        port = next;
        say(`[ok] Using ${port} instead.`);
        break;
      }
    }
    say(`[ok] Port ${port}.`);
    say('');

    // 5. Write the config --------------------------------------------------
    const contents = renderConfig({ masterKey, claudeBinary: binaryPath, port });
    if (!await prompter.confirm(`Write ${configFile} (mode 0600)?`, true)) {
      say('[!] Skipped. Set these in your shell instead and the server behaves identically:');
      say('      SESSION_LAB_GATEWAY=1');
      say(`      SESSION_LAB_MASTER_KEY=${masterKey}`);
      say(`      CLAUDE_BINARY=${binaryPath}`);
      say(`      SESSION_LAB_PORT=${port}`);
      return 0;
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(configFile, contents, { mode: 0o600 });
    try {
      await chmod(dataDir, 0o700);
      await chmod(configFile, 0o600);
    } catch {
      // Best effort; the notice below covers the platforms that ignore POSIX modes.
    }
    say(`[ok] Wrote ${configFile}`);
    if (platform === 'win32') {
      say('[!] Windows largely ignores POSIX file modes: this file is only as private as your');
      say('    user profile. Tighten it with icacls if the machine has other accounts.');
    } else {
      say('     data/ is 0700, the file is 0600, and data/ is already gitignored.');
    }
    say('');

    if (masterKeyIsNew) {
      say('Master key - save it somewhere safe now:');
      say(`  ${masterKey}`);
      say('  Lose it and every stored token is unrecoverable; the server then refuses to start');
      say('  with KEYSTORE_UNREADABLE. It is also in the 0600 file above, nowhere else.');
      say('');
    }

    // 6. Link an account ---------------------------------------------------
    const childEnv = {
      ...process.env,
      SESSION_LAB_GATEWAY: '1',
      SESSION_LAB_MASTER_KEY: masterKey,
      CLAUDE_BINARY: binaryPath,
      SESSION_LAB_PORT: String(port),
    };
    let apiKey = null;

    say('Link a Claude account:');
    say('  1) Local claude CLI account - fastest, but it shares this machine\'s refresh token,');
    say('     so whichever side refreshes first can sign the other out.');
    say('  2) Browser (admin UI) - a few clicks more, and lets you link a separate account.');
    say('  The keystore takes an exclusive lock, so option 1 needs the server NOT running.');
    const choice = await prompter.ask('Choose 1 or 2 (or "skip"):', '1');

    if (choice === '1') {
      let credentials = null;
      try {
        credentials = await readLocalClaudeCredentials({ platform });
      } catch (error) {
        say(`[!] ${error.publicMessage ?? error.message}`);
      }
      if (credentials && !credentials.oauth?.accessToken) {
        say(`[!] ${credentials.source} has no claudeAiOauth.accessToken. Run \`claude\` and sign in.`);
        credentials = null;
      }
      if (credentials && credentials.sourceKind === 'keychain') {
        // link-local resolves credentials through the same platform helper, so the Keychain
        // works there too; macOS may raise one access prompt when the child reads it.
        say('[!] Your credentials are in the macOS login Keychain. Approve the access prompt');
        say('    if macOS shows one; otherwise this falls back to the browser flow.');
      }
      if (credentials) {
        say(`[ok] Local credentials found in ${credentials.source}.`);
        const label = await prompter.ask('Label for this key:', 'my-app');
        const result = await runCapture(process.execPath, [join(REPO_ROOT, 'scripts', 'link-local.mjs'), label], childEnv);
        for (const line of result.stdout.trimEnd().split('\n')) if (line) say(`     ${line}`);
        apiKey = extractApiKey(result.stdout);
        if (result.code !== 0 || !apiKey) {
          for (const line of result.stderr.trimEnd().split('\n')) if (line) say(`[!]  ${line}`);
          if (/KEYSTORE_LOCKED|already has this keystore open/.test(result.stderr)) {
            say('[!] Stop the running server and re-run this script; the keystore lock is exclusive.');
          }
          apiKey = null;
          say('[!] Linking did not produce a key. You can still link through the browser (option 2).');
        } else {
          say('[ok] Linked. The key above is shown once - it is stored only as a hash.');
        }
      }
    }

    if (!apiKey) {
      say('');
      say('Link through the browser instead:');
      say('  1. Start the server (command below).');
      say(`  2. Open http://127.0.0.1:${port} in a browser on THIS machine.`);
      say(`     Remote host? Tunnel first: ssh -N -L ${port}:127.0.0.1:${port} user@host`);
      say('  3. Sign in there; the admin UI runs the PKCE flow and issues the csl_sk_... key.');
      say('  The running server holds the keystore lock, which is fine - the UI links through it.');
      say('  Do not run link-local while the server runs; it fails with KEYSTORE_LOCKED.');
    }
    say('');

    // 7. Optional service install -----------------------------------------
    const service = renderServiceFile({ platform, port });
    if (!service) {
      say(`[!] No autostart recipe for ${platformLabel(platform)}; start the server yourself.`);
    } else {
      say(`Keep the gateway running after this terminal closes? (${service.kind})`);
      if (await prompter.confirm(`Write ${service.path}?`, false)) {
        await mkdir(dirname(service.path), { recursive: true });
        if (service.logDir) await mkdir(service.logDir, { recursive: true });
        await writeFile(service.path, service.contents);
        say(`[ok] Wrote ${service.path}`);
        say('     Now run these yourself (setup does not enable anything for you):');
        for (const command of service.commands) say(`       ${command}`);
        if (service.note) say(`     ${service.note}`);
      } else {
        say('[ok] Skipped - nothing was written.');
        if (service.note) say(`     ${service.note}`);
      }
    }
    say('');

    // 8. Finish -----------------------------------------------------------
    const startCommand = platform === 'win32'
      ? 'node --env-file-if-exists=data\\gateway.env src\\server.mjs'
      : 'node --env-file-if-exists=data/gateway.env src/server.mjs';
    say('Done. ---------------------------------------------------------------');
    say('Start it:');
    say(`  cd ${REPO_ROOT}`);
    say('  npm start');
    say(`  (that is: ${startCommand} - the flag is what loads the config above.)`);
    say('');
    say('Prove it works:');
    say(`  ${curlCommand({ platform, port, apiKey })}`);
    say('');
    say('In your app:');
    say(`  baseURL: http://127.0.0.1:${port}/v1`);
    say(`  apiKey : ${apiKey ?? 'csl_sk_... (from link-local or the admin UI)'}`);
    say('');
    say('More: examples/ (curl.sh, anthropic-sdk.mjs, openai-sdk.mjs, chat-loop.mjs) and docs/API.md');
    return 0;
  } finally {
    prompter.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then(
    (code) => process.exit(code ?? 0),
    (error) => {
      say(`[x] setup failed: ${error?.publicMessage ?? error?.message ?? error}`);
      process.exit(1);
    },
  );
}
