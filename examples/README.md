# Examples

Runnable scripts that talk to a gateway you have already started. Each one reads two
environment variables:

```bash
export CSL_KEY=csl_sk_...                  # the key link-local or the admin UI printed
export CSL_URL=http://127.0.0.1:3210       # your gateway (default if unset)
```

| File | What it shows |
|---|---|
| `curl.sh` | Buffered and streaming requests with no dependencies at all (bash: Linux, macOS, WSL) |
| `curl.ps1` | The same two requests from PowerShell on Windows |
| `anthropic-sdk.mjs` | Official `@anthropic-ai/sdk`, buffered + streaming |
| `openai-sdk.mjs` | Apps already written against OpenAI |
| `chat-loop.mjs` | Multi-turn conversation state, the way a real chat app keeps it. Interactive — piping a whole script into it only runs the first turn, because readline consumes the buffered input at once |

## curl needs nothing

```bash
bash examples/curl.sh          # Linux, macOS, WSL
```

```powershell
.\examples\curl.ps1           # Windows PowerShell
```

## The SDK examples need their package installed

This project has zero runtime dependencies, so the SDKs are not vendored here. Node resolves
imports from the **script's own directory**, not your shell's working directory, so copy the
example next to the installed packages rather than running it in place:

Run this from inside your clone, so `$REPO` picks up wherever you put it:

```bash
REPO=$(pwd)
mkdir -p /tmp/csl-example && cd /tmp/csl-example
npm init -y >/dev/null && npm install @anthropic-ai/sdk openai
cp "$REPO"/examples/*.mjs .

node anthropic-sdk.mjs
node openai-sdk.mjs
node chat-loop.mjs      # interactive; blank line or Ctrl-D to quit
```
