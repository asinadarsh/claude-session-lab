import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT,
  claudeCandidates,
  extractApiKey,
  parseEnvFile,
  parsePort,
  renderConfig,
  renderServiceFile,
} from '../scripts/setup.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('parsePort accepts valid ports and rejects the rest', () => {
  assert.equal(parsePort('3210'), 3210);
  assert.equal(parsePort(3210), 3210);
  assert.equal(parsePort('1024'), 1024);
  assert.equal(parsePort('65535'), 65535);
  assert.equal(parsePort('80'), null);
  assert.equal(parsePort('1023'), null);
  assert.equal(parsePort('70000'), null);
  assert.equal(parsePort('abc'), null);
  assert.equal(parsePort('32 10'), null);
  assert.equal(parsePort('-1'), null);
  assert.equal(parsePort('3210.5'), null);
  assert.equal(parsePort(''), DEFAULT_PORT);
  assert.equal(parsePort('  '), DEFAULT_PORT);
  assert.equal(parsePort(undefined, 4000), 4000);
});

test('renderConfig emits every required key, unquoted and unescaped', () => {
  const masterKey = 'K3+abc/def+ghi/jkl+mno/pqr+stu/vwx+yz0=';
  const claudeBinary = 'C:\\Program Files\\nodejs\\claude.cmd';
  const contents = renderConfig({ masterKey, claudeBinary, port: 4321 });

  assert.match(contents, /^SESSION_LAB_GATEWAY=1$/m);
  assert.match(contents, /^SESSION_LAB_MASTER_KEY=/m);
  assert.match(contents, /^CLAUDE_BINARY=/m);
  assert.match(contents, /^SESSION_LAB_PORT=4321$/m);

  // Node's --env-file parser takes the rest of the line verbatim, so base64 padding and
  // Windows backslashes must survive untouched and unquoted.
  const parsed = parseEnvFile(contents);
  assert.equal(parsed.SESSION_LAB_MASTER_KEY, masterKey);
  assert.equal(parsed.CLAUDE_BINARY, claudeBinary);
  assert.equal(parsed.SESSION_LAB_GATEWAY, '1');
  assert.equal(parsed.SESSION_LAB_PORT, '4321');
  assert.ok(!contents.includes('"'), 'values must not be quoted');
  assert.ok(!contents.includes("'"), 'values must not be quoted');
  assert.ok(!contents.includes('\\\\'), 'backslashes must not be doubled');
  assert.ok(contents.endsWith('\n'));
  assert.equal(parsePort(parsed.SESSION_LAB_PORT), 4321);
});

test('renderConfig refuses input that would corrupt the file', () => {
  assert.throws(() => renderConfig({ masterKey: '', claudeBinary: 'claude' }), /masterKey is required/);
  assert.throws(() => renderConfig({ masterKey: 'k', claudeBinary: '' }), /claudeBinary is required/);
  assert.throws(
    () => renderConfig({ masterKey: 'k\nSESSION_LAB_HOST=0.0.0.0', claudeBinary: 'claude' }),
    /must not contain a newline/,
  );
  assert.throws(() => renderConfig({ masterKey: 'k', claudeBinary: 'claude', port: 80 }), /1024-65535/);
});

test('extractApiKey finds the key in realistic link-local output', () => {
  const stdout = [
    'Linked a***@example.com (max) as "my-app".',
    `Keystore: ${join(repoRoot, 'data', 'keystore.json')}`,
    '',
    'Gateway key (shown once, store it now):',
    'csl_sk_Zm9vYmFyYmF6cXV1eF9hYmNkZWZnaGlqa2w',
    '',
    'This copies the refresh token that Claude Code on this machine also uses.',
  ].join('\n');
  assert.equal(extractApiKey(stdout), 'csl_sk_Zm9vYmFyYmF6cXV1eF9hYmNkZWZnaGlqa2w');
});

test('extractApiKey returns null when no key was printed', () => {
  assert.equal(extractApiKey('link-local: SESSION_LAB_MASTER_KEY is required.'), null);
  assert.equal(extractApiKey(''), null);
  assert.equal(extractApiKey(undefined), null);
  assert.equal(extractApiKey('csl_sk_tooshort'), null);
});

test('renderServiceFile builds a systemd user unit with an absolute ExecStart', () => {
  const service = renderServiceFile({
    platform: 'linux',
    execPath: '/home/dev/.nvm/versions/node/v24.18.0/bin/node',
    repoRoot: '/home/dev/claude-session-lab',
    home: '/home/dev',
    port: 3210,
  });

  assert.equal(service.path, '/home/dev/.config/systemd/user/claude-session-lab.service');
  const execStart = service.contents.split('\n').find((line) => line.startsWith('ExecStart='));
  assert.equal(
    execStart,
    'ExecStart="/home/dev/.nvm/versions/node/v24.18.0/bin/node" '
      + '"--env-file-if-exists=/home/dev/claude-session-lab/data/gateway.env" '
      + '"/home/dev/claude-session-lab/src/server.mjs"',
  );
  assert.match(service.contents, /^\[Install\]$/m);
  assert.match(service.contents, /^WantedBy=default\.target$/m);
  assert.match(service.contents, /^WorkingDirectory=\/home\/dev\/claude-session-lab$/m);
  assert.ok(!service.contents.includes('SESSION_LAB_MASTER_KEY'), 'the unit must not carry the secret');
  assert.ok(service.commands.some((command) => command.includes('systemctl --user daemon-reload')));
  assert.ok(service.commands.some((command) => command.includes('enable-linger')));
});

test('renderServiceFile builds a launchd plist with the right ProgramArguments', () => {
  const service = renderServiceFile({
    platform: 'darwin',
    execPath: '/opt/homebrew/bin/node',
    repoRoot: '/Users/dev/claude-session-lab',
    home: '/Users/dev',
    port: 3300,
  });

  assert.equal(service.path, '/Users/dev/Library/LaunchAgents/com.claude-session-lab.gateway.plist');
  assert.match(service.contents, /<key>Label<\/key>\n\s*<string>com\.claude-session-lab\.gateway<\/string>/);
  const args = [...service.contents.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]);
  const start = args.indexOf('/opt/homebrew/bin/node');
  assert.ok(start >= 0, 'ProgramArguments must start with the absolute node path');
  assert.deepEqual(args.slice(start, start + 3), [
    '/opt/homebrew/bin/node',
    '--env-file-if-exists=/Users/dev/claude-session-lab/data/gateway.env',
    '/Users/dev/claude-session-lab/src/server.mjs',
  ]);
  assert.match(service.contents, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(service.contents, /<key>KeepAlive<\/key>\n\s*<true\/>/);
  assert.match(service.contents, /<key>WorkingDirectory<\/key>\n\s*<string>\/Users\/dev\/claude-session-lab<\/string>/);
  assert.match(service.contents, /<key>StandardOutPath<\/key>/);
  assert.match(service.contents, /<key>StandardErrorPath<\/key>/);
  assert.equal(service.logDir, '/Users/dev/claude-session-lab/logs');
  assert.ok(service.commands.some((command) => command.startsWith('launchctl load -w ')));
  assert.ok(!service.contents.includes('SESSION_LAB_MASTER_KEY'));
});

test('renderServiceFile gives Windows a launcher plus a schtasks onlogon command', () => {
  const service = renderServiceFile({
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    repoRoot: 'C:\\Users\\dev\\claude-session-lab',
    home: 'C:\\Users\\dev',
    port: 3210,
  });

  assert.equal(service.path, 'C:\\Users\\dev\\claude-session-lab\\data\\start-gateway.cmd');
  assert.ok(service.contents.includes('"C:\\Program Files\\nodejs\\node.exe"'), 'quoted absolute node path');
  assert.ok(
    service.contents.includes('"--env-file-if-exists=C:\\Users\\dev\\claude-session-lab\\data\\gateway.env"'),
    'the env file must be a quoted Windows path',
  );
  assert.ok(service.contents.includes('"C:\\Users\\dev\\claude-session-lab\\src\\server.mjs"'));
  assert.ok(service.contents.startsWith('@echo off'));
  assert.ok(service.contents.includes('\r\n'), 'a .cmd file needs CRLF line endings');
  assert.ok(!service.contents.includes('/claude-session-lab'), 'no host separators leaked in');
  const create = service.commands.find((command) => command.startsWith('schtasks /create'));
  assert.ok(create, 'a schtasks /create command is required');
  assert.match(create, /\/sc onlogon/);
  assert.ok(!/\bnssm\b|\bsc\.exe\b/.test(service.commands.join(' ')), 'no invented service wrapper');
  assert.match(service.note, /closing the terminal stops the server/);
});

test('renderServiceFile declines to guess on unknown platforms', () => {
  assert.equal(renderServiceFile({ platform: 'freebsd', home: '/home/dev', repoRoot: '/srv/app' }), null);
});

test('claudeCandidates puts CLAUDE_BINARY first and adds per-OS defaults', () => {
  const linux = claudeCandidates({
    platform: 'linux',
    env: { CLAUDE_BINARY: '/opt/claude/bin/claude', PATH: '/usr/bin:/usr/local/bin' },
    home: '/home/dev',
  });
  assert.equal(linux[0], '/opt/claude/bin/claude');
  assert.ok(linux.includes('/usr/bin/claude'));
  assert.ok(linux.includes('/home/dev/.local/bin/claude'));
  assert.equal(new Set(linux).size, linux.length, 'candidates must be de-duplicated');

  const darwin = claudeCandidates({ platform: 'darwin', env: { PATH: '' }, home: '/Users/dev' });
  assert.ok(darwin.includes('/opt/homebrew/bin/claude'));

  const win = claudeCandidates({
    platform: 'win32',
    env: { Path: 'C:\\bin', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
    home: 'C:\\Users\\dev',
  });
  assert.ok(win.includes('C:\\bin\\claude.cmd'));
  assert.ok(win.includes('C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd'), 'the npm -g shim must be checked');
  assert.ok(win.includes('C:\\Users\\dev\\AppData\\Local\\Programs\\claude\\claude.exe'));
  assert.ok(win.every((candidate) => /\.(cmd|exe|bat)$/.test(candidate)), 'Node cannot spawn an extensionless shim');
  assert.ok(win.every((candidate) => !candidate.includes('/')), 'no host separators leaked in');
});

test('parseEnvFile ignores comments and blank lines', () => {
  const parsed = parseEnvFile('# note\n\nA=1\nB=has=equals\nnot a pair\n=novalue\n');
  assert.deepEqual(parsed, { A: '1', B: 'has=equals' });
});

test('importing the module runs nothing interactive', async () => {
  // The import at the top of this file already proves it: a started flow would have
  // written data/gateway.env or blocked on stdin. Assert the guard is present too.
  const source = await import('node:fs/promises').then((fs) => fs.readFile(join(repoRoot, 'scripts', 'setup.mjs'), 'utf8'));
  assert.match(source, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
});

test('--help exits 0 without prompting, even with stdin closed', async () => {
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'setup.mjs'), '--help'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout }); });
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /node scripts\/setup\.mjs \[--yes\] \[--help\]/);
});
