# Installing Claude Session Lab

Per-platform installation reference. Read **[Before you start](#before-you-start)**, then jump to
your OS: **[Ubuntu / Linux](#ubuntu--linux)**, **[macOS](#macos)**, **[Windows](#windows)**.

The gateway itself is the same everywhere; what differs is where Node comes from, where the
`claude` CLI keeps its credentials, and how you keep the server running. Those differences are
collected in [Platform differences that actually matter](#platform-differences-that-actually-matter).

## Before you start

Three prerequisites.

**Node.js 24 or newer.** `package.json` declares `"engines": { "node": ">=24.0.0" }`, and the code
uses ESM-only, modern-Node features throughout.

```bash
node -v      # want v24.x or newer
```

**The `claude` CLI, installed and signed in.** Every request is served by spawning that CLI in a
sandbox; there is no HTTP fallback.

```bash
claude --version
claude          # then run /login if you are not signed in yet
```

**A Claude subscription you own.** The gateway does not have credentials of its own — it re-uses the
OAuth token of a subscription account you sign in with, so inference is metered against that
subscription's five-hour window.

> [!IMPORTANT]
> Link only accounts you own, and serve only your own apps. See the notice at the top of the
> [README](../README.md) before you enable gateway mode.

Then get the code and confirm the test suite passes on your machine — it needs no Claude account and
is the fastest way to catch a wrong Node version:

```bash
git clone https://github.com/asinadarsh/claude-session-lab.git
cd claude-session-lab
npm test
```

## The quick path

```bash
npm run setup
```

The interactive installer asks for:

- whether to enable gateway mode (it generates the 32-byte master key for you);
- a label for the first gateway key, so the account signed in on this machine can be linked
  immediately;
- whether to write a service file for your platform (systemd user unit, launchd plist, or a
  scheduled task) so the server survives logout and reboot.

It writes `data/gateway.env` with mode `600` — that file holds the master key, so on POSIX systems
it is readable only by you — and, if you asked for it, the service file. Both the master key and the
first `csl_sk_...` key are printed **once**, at the end.

```bash
npm run setup -- --yes
```

`--yes` runs non-interactively with the defaults and no prompts, for scripted or remote installs.

> [!WARNING]
> The master key is the one secret with no recovery path. It encrypts the stored OAuth token. Copy
> it into your password manager before you close the terminal: with the wrong key the server refuses
> to start against an existing `data/keystore.json` (`KEYSTORE_UNREADABLE`), and the only remedy is
> to delete the keystore, re-link, and re-issue every app key.

> [!NOTE]
> The application never reads `.env` files by itself — `src/config.mjs` reads environment variables
> only. `data/gateway.env` is loaded by Node, not by the app: start the server with
> `node --env-file-if-exists=data/gateway.env src/server.mjs`. A missing file is tolerated (Node
> prints a notice). A variable already set in your shell **wins** over the same variable in the
> file, which is worth remembering when an old `export` is still in scope.

Everything below is the manual equivalent, per platform, plus the parts the installer cannot do for
you.

## Ubuntu / Linux

Developed and tested here; this is the best-supported platform.

### Node

Either source works, but they lead to different service files:

```bash
# Distribution / NodeSource packages — Node lands on the system PATH
node -v
command -v node         # e.g. /usr/bin/node

# nvm, fnm, volta, asdf — Node lives under your home directory
command -v node         # e.g. /home/you/.nvm/versions/node/v24.4.0/bin/node
```

> [!IMPORTANT]
> A version manager puts Node on your **shell's** `PATH` only. The systemd user manager does not
> inherit that `PATH`, so a unit with `ExecStart=node ...` fails with `203/EXEC`. Always write an
> absolute path — `$(command -v node)` — into the unit.

### The claude CLI

A native install usually lands in `~/.local/bin/claude`; a global npm install lands in your npm
prefix (`$(npm prefix -g)/bin/claude`). Either way, resolve it once and set `CLAUDE_BINARY` to the
absolute path for the same reason as Node:

```bash
command -v claude
```

### Run it

```bash
export SESSION_LAB_GATEWAY=1
export SESSION_LAB_MASTER_KEY="$(openssl rand -base64 32)"
echo "$SESSION_LAB_MASTER_KEY"        # save this now

npm run link-local -- my-app          # prints one csl_sk_... key
npm start
```

Link **before** starting the server: the keystore takes an exclusive lock for the process lifetime,
so `link-local` against a running server exits with `KEYSTORE_LOCKED` and changes nothing.

### Keep it running

A `systemd --user` service is the least-fuss option: no root, restarts after a crash or reboot.
Stop the foreground `npm start` first — one process at a time may hold the keystore and the port.

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/claude-session-lab.service <<EOF
[Unit]
Description=Claude Session Lab gateway

[Service]
WorkingDirectory=$(pwd)
Environment=SESSION_LAB_GATEWAY=1
Environment=SESSION_LAB_MASTER_KEY=$SESSION_LAB_MASTER_KEY
Environment=CLAUDE_BINARY=$(command -v claude)
ExecStart=$(command -v node) src/server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
EOF

chmod 600 ~/.config/systemd/user/claude-session-lab.service   # it holds your master key
systemctl --user daemon-reload
systemctl --user enable --now claude-session-lab
loginctl enable-linger "$USER"     # without this, the service stops when you log out
```

Run that from inside the clone, in the terminal where the master key is still exported, so the
paths and the key are substituted for you. `cat` the result before enabling it.

For a public deployment behind a domain — dedicated service user, filesystem protections, reverse
proxy — use [DEPLOY.md](DEPLOY.md) instead of this unit.

### Sandbox

On Linux the per-request sandbox is created under `/dev/shm/claude-session-lab` (tmpfs), so the
credential file each request needs never reaches a disk. If `/dev/shm` is missing or not writable,
`sandboxBase()` falls back to the OS temp directory and the sandbox is disk-backed. That is also why
the hardened unit in DEPLOY.md keeps `PrivateTmp=no`.

## macOS

The server runs here. The one rough edge is credential discovery, below.

### Node

```bash
brew install node        # Homebrew
node -v
command -v node
```

Homebrew's prefix differs by architecture: `/opt/homebrew` on Apple Silicon, `/usr/local` on Intel,
so Node is typically `/opt/homebrew/bin/node` or `/usr/local/bin/node`. nvm works too and puts Node
under your home directory. As on Linux, a launchd job does not inherit your interactive shell's
`PATH`, so use absolute paths in the plist.

### Credentials live in the Keychain

Claude Code on macOS stores its credentials in the **login Keychain**, not in
`~/.claude/.credentials.json`. `npm run link-local` handles that through
`readLocalClaudeCredentials()` in `src/platform.mjs`, which runs

```bash
security find-generic-password -s "Claude Code-credentials" -w
```

first and falls back to the credentials file. The first time it runs, macOS may show a Keychain
access prompt — approve it, or nothing can be read. If you would rather not grant that access, two
alternatives:

- link through the browser PKCE flow in the admin UI (see [README](../README.md#managing-keys)) —
  it never touches the local CLI's credentials, and can link a different account;
- set `CLAUDE_CREDENTIALS` to a file containing the same JSON (a `claudeAiOauth` object).

The entry name is not a documented contract, so several candidates are tried in order
(`Claude Code-credentials`, `Claude Code`, `claude-code-credentials`). If your install uses
another, name it explicitly and skip the guessing:

```bash
security dump-keychain | grep -i -A1 claude    # find the service name
CLAUDE_KEYCHAIN_SERVICE="whatever it is" npm run link-local -- my-app
```

Both the plain and hex-encoded payload forms are handled, and the failure message lists every
name that was tried.

### Keep it running

`~/Library/LaunchAgents/com.example.claude-session-lab.plist` — adapt the paths, they are examples:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.claude-session-lab</string>
  <key>WorkingDirectory</key><string>/Users/you/claude-session-lab</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>src/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SESSION_LAB_GATEWAY</key><string>1</string>
    <key>SESSION_LAB_MASTER_KEY</key><string>your-master-key</string>
    <key>CLAUDE_BINARY</key><string>/opt/homebrew/bin/claude</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```bash
chmod 600 ~/Library/LaunchAgents/com.example.claude-session-lab.plist   # it holds your master key
launchctl load ~/Library/LaunchAgents/com.example.claude-session-lab.plist
```

`launchctl unload <plist>` stops it — do that before running `link-local`, or you get
`KEYSTORE_LOCKED`.

> [!NOTE]
> A launchd agent runs in your login session, so a Keychain read may prompt where no one can answer
> it. Link the account interactively first, then start the agent.

### Sandbox

There is no `/dev/shm` on macOS, so `sandboxBase()` uses `<os tmpdir>/claude-session-lab`
(mode `700`). The per-request credential file is written there and deleted when the request ends,
including on crash or forced exit — but unlike Linux it is disk-backed while it exists.

## Windows

Examples below are PowerShell, not bash.

### Node

Install from <https://nodejs.org> (LTS 24 or newer) or with winget:

```powershell
winget install OpenJS.NodeJS
node -v
```

### The claude.cmd problem

A global npm install (`npm i -g @anthropic-ai/claude-code`) leaves a `claude.cmd` shim in
`%AppData%\npm`. Node cannot spawn a `.cmd` without a shell, and running a shell with request-derived
arguments would be an injection risk. So `resolveClaudeCommand()` in `src/platform.mjs` searches
`PATH` for `claude.exe`, `claude.cmd`, `claude.bat`, and when it finds a `.cmd`/`.bat` shim it
prefers the CLI's own JavaScript entry point —
`node_modules\@anthropic-ai\claude-code\cli.js` next to the shim — executed with the current Node
binary. `cmd.exe` is only the last resort, when that entry point cannot be found.

If auto-detection fails you get `CLAUDE_BINARY_MISSING`. Set `CLAUDE_BINARY` to a full path:

```powershell
Get-Command claude | Select-Object -ExpandProperty Source
$env:CLAUDE_BINARY = "C:\Users\you\AppData\Roaming\npm\claude.cmd"
```

A path to `cli.js` itself also works, and skips the shim resolution entirely.

### Environment variables

For the current session only:

```powershell
$env:SESSION_LAB_GATEWAY = "1"
# Get-Random is not a cryptographic RNG - use the platform CSPRNG for a key that
# protects an OAuth token.
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$env:SESSION_LAB_MASTER_KEY = [Convert]::ToBase64String($bytes)
$env:SESSION_LAB_MASTER_KEY        # save this now
```

Persistently, for future sessions (takes effect in new terminals, not the current one):

```powershell
setx SESSION_LAB_GATEWAY 1
setx SESSION_LAB_MASTER_KEY "your-master-key"
```

> [!WARNING]
> `setx` writes to the user environment in the registry, and both the command and the value land in
> your PowerShell history. It is convenient, not private. `data/gateway.env` plus
> `node --env-file-if-exists=data/gateway.env src/server.mjs` keeps the key in one file instead.

Then:

```powershell
npm run link-local -- my-app
npm start
```

### Keep it running

Windows has no per-user service manager comparable to `systemd --user`. A logon-triggered scheduled
task is the supported approach — adapt the paths:

```powershell
schtasks /create /tn "ClaudeSessionLab" /sc onlogon `
  /tr "cmd /c cd /d C:\Users\you\claude-session-lab && node --env-file-if-exists=data\gateway.env src\server.mjs"
```

Manage it with `schtasks /run /tn "ClaudeSessionLab"`, `/end`, `/query`, `/delete`. End the task
before running `link-local`.

### WSL2

If you would rather not deal with any of the above, install into WSL2 and follow
[Ubuntu / Linux](#ubuntu--linux) exactly — inside WSL the code takes the Linux paths, including the
`/dev/shm` tmpfs sandbox and process-group termination. Reach it from Windows apps at
`http://127.0.0.1:3210`; recent WSL2 forwards localhost, and `SESSION_LAB_HOST` should stay on
loopback either way.

## Platform differences that actually matter

| | Linux / WSL2 | macOS | Windows |
|---|---|---|---|
| Sandbox backing | `/dev/shm/claude-session-lab` (tmpfs) — request credentials never reach disk; falls back to OS temp if `/dev/shm` is unusable | `<os tmpdir>/claude-session-lab` — disk-backed, deleted at end of request | `%TEMP%\claude-session-lab` — disk-backed, deleted at end of request |
| File modes (`600`/`700`) | Enforced by the kernel | Enforced by the kernel | Largely inert: Node's `mode` argument does not translate to an ACL. What protects `data\` and `gateway.env` is the default NTFS permissions on your user profile directory — no extra protection is added, so keep the clone under your profile and not on a shared or removable volume |
| Killing the CLI's children | `process.kill(-pid, signal)` on the detached process group, so descendants die too | Same as Linux | No process groups; `taskkill /pid <pid> /T /F`, then `child.kill()` |
| Local credentials | `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`, or `CLAUDE_CREDENTIALS`) | Login Keychain via `security find-generic-password -s "Claude Code-credentials" -w`, with the file as fallback | Same file as Linux, under your profile |
| `claude` invocation | Spawned directly | Spawned directly | Resolved to `.exe`, else the package's `cli.js` run with the current Node, else `cmd.exe /d /s /c` as a last resort |
| Keep-alive | `systemd --user` + `loginctl enable-linger`; root unit in [DEPLOY.md](DEPLOY.md) | launchd user agent (`launchctl load`) | `schtasks /sc onlogon`, or WSL2 with the Linux setup |

Two things are identical everywhere: the server binds `127.0.0.1` by default, and only one process
may hold `data/keystore.json` at a time.

## Verifying the install

Health, which needs no API key:

```bash
curl http://127.0.0.1:3210/api/health
```

```json
{"ok":true,"gateway":true,"connections":1}
```

`"gateway": false` means `SESSION_LAB_GATEWAY=1` did not reach the server's environment — every
`/v1/*` call will answer `503 GATEWAY_DISABLED`. `"connections": 0` means nothing is linked yet.

Then one real request. Bash:

```bash
curl http://127.0.0.1:3210/v1/messages \
  -H "x-api-key: csl_sk_..." \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":100,
       "messages":[{"role":"user","content":"Reply with exactly: it works"}]}'
```

PowerShell — `curl` is an alias for `Invoke-WebRequest` in some setups, and `curl.exe` needs the
JSON body single-quoted with doubled inner quotes, so this form is the reliable one:

```powershell
curl.exe http://127.0.0.1:3210/v1/messages `
  -H "x-api-key: csl_sk_..." `
  -H "content-type: application/json" `
  -d '{\"model\":\"claude-sonnet-5\",\"max_tokens\":100,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: it works\"}]}'
```

A successful response is an Anthropic `message` object:

```json
{"type":"message","role":"assistant","content":[{"type":"text","text":"it works"}],
 "stop_reason":"end_turn","usage":{"input_tokens":175,"output_tokens":5}}
```

The first request is slower than later ones: it pays CLI startup on top of model latency. Full
request and response contract in [API.md](API.md).

## Troubleshooting by platform

**`CLAUDE_BINARY_MISSING`** — the CLI could not be resolved.
- *Linux/macOS*: the process's `PATH` does not contain `claude`. A service manager does not inherit
  your shell's `PATH`; set `CLAUDE_BINARY=$(command -v claude)` in the unit or plist.
- *Windows*: `PATH` has no `claude.exe`/`.cmd`/`.bat`, or a `.cmd` shim was found but the
  `node_modules\@anthropic-ai\claude-code\cli.js` beside it is missing. Set `CLAUDE_BINARY` to the
  full path of the shim or of `cli.js`.

**`LOCAL_CREDENTIALS_UNAVAILABLE`** — no local Claude credentials could be read.
- *macOS*: the login Keychain has no readable `Claude Code-credentials` entry, or the access prompt
  was denied or never appeared (common when the process runs under launchd). Link interactively,
  approve the prompt, use the browser PKCE flow, or point `CLAUDE_CREDENTIALS` at a file.
- *Linux/Windows*: you are not signed in. Run `claude`, then `/login`. If your credentials live
  somewhere non-standard, set `CLAUDE_CONFIG_DIR` or `CLAUDE_CREDENTIALS`.

**`KEYSTORE_LOCKED`** — the server is already running and holds the exclusive keystore lock. Stop it
(`systemctl --user stop`, `launchctl unload`, `schtasks /end`, or Ctrl-C), run `link-local`, start it
again. Or issue the key from the browser admin UI, which works while the server runs.

**`MASTER_KEY_INVALID`** — `SESSION_LAB_MASTER_KEY` is not 32 bytes of base64 or 64 hex characters.
Regenerate with `openssl rand -base64 32`. On Windows, watch for a trailing newline or stray quotes
picked up by `setx`.

**`KEYSTORE_UNREADABLE`** — the master key does not decrypt the existing `data/keystore.json`, or
the file was edited. Restore the correct key. If it is genuinely lost, delete the keystore, re-link,
and re-issue every app key; the old token is not recoverable.

**Gateway mode refuses to start** — `SESSION_LAB_GATEWAY=1` without `SESSION_LAB_MASTER_KEY` throws
at startup, by design. Set both, in the same environment.

**Port already in use** — something else holds 3210, often an older copy of this server.
- *Linux*: `ss -ltnp | grep 3210`
- *macOS*: `lsof -nP -iTCP:3210 -sTCP:LISTEN`
- *Windows*: `netstat -ano | findstr :3210` then `Get-Process -Id <pid>`

Or move the gateway with `SESSION_LAB_PORT` (1024–65535).

**systemd `status=203/EXEC`** — the unit's `ExecStart` names a binary the systemd user manager
cannot see, almost always a version-manager Node (`nvm`, `fnm`, `volta`, `asdf`) that only exists on
your shell's `PATH`. Rewrite `ExecStart` with the output of `command -v node`. Check with
`systemctl --user cat claude-session-lab` and `journalctl --user -u claude-session-lab -n 50`.

**Server exits mentioning the bind address** — `SESSION_LAB_HOST` is off-localhost, which also
requires `SESSION_LAB_ALLOW_PUBLIC_BIND=1`. Prefer a reverse proxy that exposes only `/v1/*`; see
[DEPLOY.md](DEPLOY.md).

Every error response carries an `X-Request-ID`, and logs are one JSON line per request, so grepping
the journal (or the task's console output) by request id is the fastest way to correlate a client
failure with a server-side cause.
