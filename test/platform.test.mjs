import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  defaultCredentialsPath,
  platformLabel,
  readLocalClaudeCredentials,
  resolveClaudeCommand,
  sandboxBase,
  spawnDetached,
  terminateTree,
} from '../src/platform.mjs';

// The host running these tests is not Windows or macOS, so every platform-specific branch is
// driven by passing the platform in explicitly along with fake fs/spawn implementations.

function existsFrom(paths) {
  const set = new Set(paths);
  return async (candidate) => set.has(candidate);
}

test('platform labels stay human readable', () => {
  assert.equal(platformLabel('win32'), 'Windows');
  assert.equal(platformLabel('darwin'), 'macOS');
  assert.equal(platformLabel('linux'), 'Linux');
  assert.equal(platformLabel('freebsd'), 'freebsd');
});

test('POSIX hosts spawn the CLI directly and detach for process-group kills', async () => {
  for (const platform of ['linux', 'darwin']) {
    const resolved = await resolveClaudeCommand('claude', { platform });
    assert.deepEqual(resolved, { command: 'claude', prefixArgs: [], kind: 'direct' });
    assert.equal(spawnDetached(platform), true);
  }
});

test('Windows prefers a real .exe over the npm shim', async () => {
  const resolved = await resolveClaudeCommand('claude', {
    platform: 'win32',
    env: { PATH: 'C:\\tools;C:\\Users\\me\\AppData\\Roaming\\npm' },
    exists: existsFrom(['C:\\tools\\claude.exe', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd']),
  });
  assert.equal(resolved.kind, 'exe');
  assert.equal(resolved.command, 'C:\\tools\\claude.exe');
  assert.deepEqual(resolved.prefixArgs, []);
});

test('Windows resolves a .cmd shim to the CLI JavaScript entry, avoiding any shell', async () => {
  const npmDir = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const entry = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  const resolved = await resolveClaudeCommand('claude', {
    platform: 'win32',
    env: { PATH: npmDir },
    exists: existsFrom([`${npmDir}\\claude.cmd`, entry]),
  });
  assert.equal(resolved.kind, 'node-script');
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.prefixArgs, [entry]);
});

test('Windows falls back to cmd.exe only when no JavaScript entry exists', async () => {
  const npmDir = 'C:\\npm';
  const resolved = await resolveClaudeCommand('claude', {
    platform: 'win32',
    env: { PATH: npmDir, ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    exists: existsFrom([`${npmDir}\\claude.cmd`]),
  });
  assert.equal(resolved.kind, 'cmd-shim');
  assert.equal(resolved.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(resolved.prefixArgs, ['/d', '/s', '/c', `${npmDir}\\claude.cmd`]);
});

test('Windows honours an explicit path and reports a clear error when nothing is found', async () => {
  const direct = await resolveClaudeCommand('D:\\apps\\claude.exe', {
    platform: 'win32',
    env: {},
    exists: existsFrom(['D:\\apps\\claude.exe']),
  });
  assert.equal(direct.command, 'D:\\apps\\claude.exe');

  await assert.rejects(
    resolveClaudeCommand('claude', { platform: 'win32', env: { PATH: 'C:\\nope' }, exists: existsFrom([]) }),
    (error) => error.code === 'CLAUDE_BINARY_MISSING' && /CLAUDE_BINARY/.test(error.publicMessage),
  );
});

test('Windows does not detach and terminates the whole tree with taskkill', () => {
  assert.equal(spawnDetached('win32'), false);

  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    return { on() {}, unref() {} };
  };
  let childKilled = false;
  const child = { pid: 4321, kill() { childKilled = true; } };

  terminateTree(child, 'SIGTERM', { platform: 'win32', spawnImpl });
  assert.deepEqual(calls, [{ command: 'taskkill', args: ['/pid', '4321', '/T', '/F'] }]);
  assert.equal(childKilled, true, 'the direct kill is still attempted as a backstop');
});

test('terminateTree ignores a child that never started', () => {
  let spawned = false;
  terminateTree(null, 'SIGTERM', { platform: 'win32', spawnImpl: () => { spawned = true; } });
  terminateTree({ pid: undefined }, 'SIGTERM', { platform: 'win32', spawnImpl: () => { spawned = true; } });
  assert.equal(spawned, false);
});

test('Linux uses tmpfs when /dev/shm is writable and falls back when it is not', async () => {
  const made = [];
  const tmpfs = await sandboxBase({
    platform: 'linux',
    statImpl: async () => ({ isDirectory: () => true }),
    accessImpl: async () => {},
    mkdirImpl: async (dir) => { made.push(dir); },
  });
  assert.equal(tmpfs.base, '/dev/shm/claude-session-lab');
  assert.equal(tmpfs.backing, 'tmpfs');

  const fallback = await sandboxBase({
    platform: 'linux',
    statImpl: async () => { throw new Error('no /dev/shm'); },
    accessImpl: async () => {},
    mkdirImpl: async (dir) => { made.push(dir); },
  });
  assert.equal(fallback.backing, 'disk');
  assert.ok(!fallback.base.startsWith('/dev/shm'));
});

test('Windows and macOS use the OS temp directory, never /dev/shm', async () => {
  for (const platform of ['win32', 'darwin']) {
    let statCalls = 0;
    const result = await sandboxBase({
      platform,
      statImpl: async () => { statCalls += 1; return { isDirectory: () => true }; },
      accessImpl: async () => {},
      mkdirImpl: async () => {},
    });
    assert.equal(statCalls, 0, 'must not probe /dev/shm off Linux');
    assert.equal(result.backing, 'os-temp');
    assert.ok(!result.base.includes('/dev/shm'));
  }
});

test('credential path follows the documented overrides', () => {
  assert.equal(
    defaultCredentialsPath({ platform: 'linux', env: { CLAUDE_CREDENTIALS: '/custom/creds.json' }, home: '/home/me' }),
    '/custom/creds.json',
  );
  assert.equal(
    defaultCredentialsPath({ platform: 'linux', env: { CLAUDE_CONFIG_DIR: '/cfg' }, home: '/home/me' }),
    '/cfg/.credentials.json',
  );
  assert.match(
    defaultCredentialsPath({ platform: 'linux', env: {}, home: '/home/me' }),
    /home[/\\]me[/\\]\.claude[/\\]\.credentials\.json/,
  );
});

function fakeKeychain(payload, { code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = Readable.from([payload]);
    child.stderr = Readable.from([]);
    setImmediate(() => child.emit('close', code));
    return child;
  };
}

test('macOS reads credentials from the Keychain before touching the filesystem', async () => {
  const oauth = { accessToken: 'from-keychain', refreshToken: 'r' };
  let fileRead = false;
  const result = await readLocalClaudeCredentials({
    platform: 'darwin',
    env: {},
    home: '/Users/me',
    spawnImpl: fakeKeychain(JSON.stringify({ claudeAiOauth: oauth })),
    readFileImpl: async () => { fileRead = true; return '{}'; },
  });
  assert.equal(result.source, 'macOS Keychain');
  assert.equal(result.oauth.accessToken, 'from-keychain');
  assert.equal(fileRead, false, 'the Keychain hit must short-circuit the file read');
});

test('macOS falls back to the credentials file when the Keychain has nothing', async () => {
  const result = await readLocalClaudeCredentials({
    platform: 'darwin',
    env: {},
    home: '/Users/me',
    spawnImpl: fakeKeychain('', { code: 44 }),
    readFileImpl: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }),
  });
  assert.match(result.source, /\.credentials\.json$/);
  assert.equal(result.oauth.accessToken, 'from-file');
});

test('an explicit CLAUDE_CREDENTIALS path skips the Keychain entirely', async () => {
  let keychainUsed = false;
  const result = await readLocalClaudeCredentials({
    platform: 'darwin',
    env: { CLAUDE_CREDENTIALS: '/tmp/creds.json' },
    home: '/Users/me',
    spawnImpl: () => { keychainUsed = true; return fakeKeychain('')(); },
    readFileImpl: async (path) => {
      assert.equal(path, '/tmp/creds.json');
      return JSON.stringify({ claudeAiOauth: { accessToken: 'explicit' } });
    },
  });
  assert.equal(keychainUsed, false);
  assert.equal(result.oauth.accessToken, 'explicit');
});

test('a failure names every place that was tried and how to fix it', async () => {
  await assert.rejects(
    readLocalClaudeCredentials({
      platform: 'darwin',
      env: {},
      home: '/Users/me',
      spawnImpl: fakeKeychain('', { code: 44 }),
      readFileImpl: async () => { const error = new Error('nope'); error.code = 'ENOENT'; throw error; },
    }),
    (error) => error.code === 'LOCAL_CREDENTIALS_UNAVAILABLE'
      && /Keychain/.test(error.publicMessage)
      && /\.credentials\.json/.test(error.publicMessage),
  );

  await assert.rejects(
    readLocalClaudeCredentials({
      platform: 'win32',
      env: {},
      home: 'C:\\Users\\me',
      readFileImpl: async () => { const error = new Error('nope'); error.code = 'ENOENT'; throw error; },
    }),
    (error) => error.code === 'LOCAL_CREDENTIALS_UNAVAILABLE' && /sign in first/.test(error.publicMessage),
  );
});
