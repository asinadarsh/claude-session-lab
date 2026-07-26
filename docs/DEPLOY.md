# Deploying the Gateway

This guide takes gateway mode from a fresh checkout to a hardened single-node deployment on a small Linux VPS. It assumes:

- Ubuntu with systemd;
- Node.js 24 installed;
- the `claude` CLI already installed at `~/.local/bin/claude` for the service user;
- Caddy already running on ports 80/443 for another service (we add a site block, not a new server).

> [!IMPORTANT]
> Gateway mode extends a research lab, not a production platform. It serves one operator's own sites and apps against one linked subscription. Do not resell access or put untrusted tenants behind it.

## 1. Master key

Gateway mode persists the linked account's OAuth tokens (the lab's memory-only model does not survive restarts, and a gateway must). Persisted tokens are encrypted with a master key that only exists in the environment:

```bash
openssl rand -base64 32
```

Set the output as `SESSION_LAB_MASTER_KEY`. Without it, gateway mode refuses to start.

> [!WARNING]
> Losing the master key means the stored tokens are unrecoverable — by design. There is no recovery path and no plaintext fallback. Re-linking the account through the PKCE flow is the only remedy. Back up the key (section 7) the moment you generate it.

## 2. Environment file

Create `/etc/claude-session-lab/env`, owned by root, mode 600, readable only via systemd's `EnvironmentFile`:

```bash
sudo mkdir -p /etc/claude-session-lab
sudo touch /etc/claude-session-lab/env
sudo chmod 600 /etc/claude-session-lab/env
```

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_LAB_MASTER_KEY` | (none — required for gateway mode) | Encrypts persisted OAuth tokens in `data/keystore.json`. |
| `SESSION_LAB_PORT` | `3210` | Loopback port. The server binds `127.0.0.1` only; this cannot be changed. |
| `CLAUDE_BINARY` | `claude` | Claude Code executable. Set to the absolute path for the service user. |
| `NODE_BINARY` | `node` | Node executable used by `run.sh`. Irrelevant under systemd, which calls node directly. |

Example contents:

```ini
SESSION_LAB_MASTER_KEY=<output of openssl rand -base64 32>
SESSION_LAB_PORT=3210
CLAUDE_BINARY=/home/csl/.local/bin/claude
```

The application does not load `.env` files itself; systemd injects this file.

## 3. Service user and unit

Create a dedicated non-root user and install the app:

```bash
sudo useradd --create-home --shell /usr/sbin/nologin csl
sudo -u csl git clone https://github.com/asinadarsh/claude-session-lab.git /home/csl/claude-session-lab
```

Install the `claude` CLI for this user so it lives at `/home/csl/.local/bin/claude`.

`/etc/systemd/system/claude-session-lab.service`:

```ini
[Unit]
Description=Claude Session Lab gateway
After=network-online.target
Wants=network-online.target

[Service]
User=csl
Group=csl
WorkingDirectory=/home/csl/claude-session-lab
EnvironmentFile=/etc/claude-session-lab/env
ExecStart=/usr/bin/node src/server.mjs
Restart=on-failure
RestartSec=3

NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/csl/claude-session-lab/data
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

# PrivateTmp is deliberately NOT enabled. The inference sandbox materializes
# request-scoped credentials under /dev/shm (tmpfs) so they never touch disk.
# PrivateTmp=yes gives the service a private, disk-backed /tmp namespace and
# interferes with the shared /dev/shm path; keeping the real /dev/shm visible
# preserves the memory-only credential guarantee.
PrivateTmp=no

[Install]
WantedBy=multi-user.target
```

> [!IMPORTANT]
> The unit must not run as root. The inference sandbox spawns the `claude` CLI with the linked account's credentials; running that as root turns any CLI escape into full host compromise, and the app never needs privileges — it binds a high loopback port and writes only inside its own directory.

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-session-lab
sudo systemctl status claude-session-lab
```

## 4. Caddy

Expose only the API surface. The browser admin UI (key creation, account linking) stays loopback-only, reachable exclusively over an SSH tunnel.

Add to your existing Caddyfile:

```caddy
gateway.example.com {
  @api path /v1/*

  handle @api {
    reverse_proxy 127.0.0.1:3210
  }

  handle {
    respond "Not found" 404
  }
}
```

The named matcher `@api path /v1/*` is the entire public surface. Everything else — `/`, `/api/*`, the UI assets — returns 404 from Caddy and never reaches the app. Reload with `sudo systemctl reload caddy`.

For admin work, tunnel from your workstation:

```bash
ssh -N -L 3210:127.0.0.1:3210 you@your-vps
```

then open <http://127.0.0.1:3210> locally to link the account and create keys.

If the service user is already signed in to Claude Code on this host, you can skip the browser
flow entirely and issue a key from the command line. The server holds an exclusive lock on the
keystore while it runs, so stop it first:

```bash
sudo systemctl stop claude-session-lab
sudo -u csl -H bash -c 'cd ~/claude-session-lab && set -a && . /etc/claude-session-lab/env && set +a && npm run link-local -- my-website'
sudo systemctl start claude-session-lab
```

Running it against a live server exits with `KEYSTORE_LOCKED` and changes nothing; that lock is
what stops two writers from silently discarding each other's keys. Use the admin UI instead when
you would rather not restart.

Note that this copies the refresh token Claude Code also uses on this host, so a refresh by
either side can force the other to sign in again. Link a separate account when that matters.

## 5. Firewall

Do not open the app port. The server only binds loopback, but keep the firewall in agreement:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow OpenSSH
sudo ufw enable
```

Port 3210 stays closed; Caddy and the SSH tunnel are the only paths in.

## 6. Backup and restore

Two things must survive a rebuild:

1. `data/keystore.json` — the encrypted token and key-hash store;
2. `SESSION_LAB_MASTER_KEY` — without it the keystore is ciphertext.

Back them up together, but not in the same place (the key decrypts the store):

```bash
sudo cp /home/csl/claude-session-lab/data/keystore.json /root/backup/
# store SESSION_LAB_MASTER_KEY in your password manager, not on this host
```

Restore is the reverse: place `keystore.json` in `data/`, set the same master key in the environment file, start the service. A restored keystore with a different master key fails to decrypt and the gateway treats the account as unlinked.

Log hygiene: logs contain timestamp, request ID, method, route, status, and duration. OAuth tokens, API keys, and request bodies are never logged, so journal exports are safe to share when reporting issues — but redact hostnames if that matters to you. `journalctl -u claude-session-lab` is the only log location.

## 7. Verify it works

Health (over the tunnel):

```bash
curl http://127.0.0.1:3210/api/health
```

Create a key in the admin UI over the tunnel, copy the `csl_sk_...` value (shown once), then from anywhere:

```bash
curl https://gateway.example.com/v1/messages \
  -H "x-api-key: csl_sk_..." \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":256,"messages":[{"role":"user","content":"Reply with the word: ready"}]}'
```

Streaming:

```bash
curl -N https://gateway.example.com/v1/messages \
  -H "x-api-key: csl_sk_..." \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Count to five."}]}'
```

You should see `event: message_start` through `event: message_stop`, and the first curl should return a `message` object with `"ready"` in its content.

## 8. Honest limits

- The linked subscription is rate-limited per five-hour window. When it is exhausted, the gateway returns `429 rate_limit_error` until the window resets; there is no overflow pool.
- Requests are serialized per linked account. Ten concurrent callers wait in a queue; throughput is one inference at a time.
- Each request pays CLI startup cost on top of model latency.
- This is a single-operator convenience, not a production multi-tenant platform: no per-key quotas, no billing, no SLA, no horizontal scaling. If you need those, use the real Anthropic API.
