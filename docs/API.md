# Gateway API

Claude Session Lab's gateway mode exposes an Anthropic-compatible API backed by the operator's own linked Claude subscription. Every request runs inside a short-lived, tool-disabled Claude Code sandbox; nothing is proxied to `api.anthropic.com` on the caller's behalf.

> [!IMPORTANT]
> This is a compatibility layer over an interactive subscription, not the Anthropic API. Read [Behavior differences](#behavior-differences-from-the-real-anthropic-api) before pointing production traffic at it.

## Authentication

Every `/v1/*` request must carry a gateway API key in one of two headers:

```text
x-api-key: csl_sk_...
```

or

```text
Authorization: Bearer csl_sk_...
```

Key properties:

- Keys are shown **once** at creation. The server stores only a SHA-256 hash; a lost key cannot be recovered, only revoked and replaced.
- One key corresponds to one linked Claude account.
- Revoked keys fail with `401 authentication_error` immediately.

## POST /v1/messages

A subset of the [Anthropic Messages API](https://docs.anthropic.com/en/api/messages).

### Supported request fields

| Field | Notes |
|---|---|
| `model` | Optional; defaults to `sonnet`. Accepts the aliases `sonnet`, `opus`, `haiku`, or any `claude-*` model id. `GET /v1/models` lists what the gateway advertises, not the only accepted values. |
| `messages` | Required. `user` and `assistant` roles; content as a string or an array of `text` and base64 `image` blocks. |
| `system` | String system prompt. |
| `max_tokens` | Optional; clamped to the range 256–64000. Omitted, zero and negative values fall back to `SESSION_LAB_DEFAULT_MAX_TOKENS` (4096). |
| `stream` | `true` for SSE streaming. |
| `stop_sequences` | **Rejected** with `400 invalid_request_error`. The CLI exposes no stop-sequence control, and accepting the field would let generation run past your delimiter while still reporting `end_turn`. Trim the response on your side. |
| `thinking` | When requested, `thinking` blocks are included in the response. |

### Rejected fields

The following are rejected with `400 invalid_request_error` rather than silently ignored:

- `tools`, and any `tool_use` / `tool_result` content blocks;
- image blocks with a `url` source (only `"type": "base64"` is supported);
- anything that requires server-side conversation state (there is none; see [Behavior differences](#behavior-differences-from-the-real-anthropic-api)).

### Example request

```bash
curl https://gateway.example.com/v1/messages \
  -H "x-api-key: csl_sk_..." \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 1024,
    "system": "You are a concise assistant.",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Describe this image in one sentence." },
          {
            "type": "image",
            "source": {
              "type": "base64",
              "media_type": "image/png",
              "data": "iVBORw0KGgo..."
            }
          }
        ]
      }
    ]
  }'
```

### Example response

```json
{
  "id": "msg_01ABC...",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-5",
  "content": [
    { "type": "text", "text": "A small terrier standing on a wooden dock." }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 1180,
    "output_tokens": 14,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

### Streaming (`"stream": true`)

The response is `text/event-stream`. Events arrive in the standard Anthropic order:

```text
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A small"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" terrier..."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":14}}

event: message_stop
data: {"type":"message_stop"}
```

`content_block_delta` may carry `text_delta`, `thinking_delta`, or `signature_delta` payloads, matching upstream. If the sandbox fails mid-stream, the gateway emits a terminal error event and closes the connection:

```text
event: error
data: {"type":"error","error":{"type":"api_error","message":"Upstream inference process failed."}}
```

Clients should treat `event: error` as fatal for the request, as with the real API.

## POST /v1/chat/completions

An OpenAI-compatible subset, translated onto the same sandbox with the same limits as `/v1/messages`.

### Mapping

| OpenAI field | Gateway behavior |
|---|---|
| `messages` with `role: "system"` | Hoisted to the Claude system prompt. Multiple system messages are concatenated in order. |
| `messages` (`user` / `assistant`) | Flattened into a single prompt, same as `/v1/messages`. |
| `model` | Passed through; must be a model from `GET /v1/models`. |
| `max_tokens` / `max_completion_tokens` | Clamped 256–64000. |
| `stop` | **Rejected** with `400 invalid_request_error` (same reason as `stop_sequences`). |
| `image_url` | A `data:<media-type>;base64,...` URL is converted to a base64 image block. A remote `http(s)` URL is **rejected** with `400`. |
| `stream` | SSE with OpenAI-style `chat.completion.chunk` objects, terminated by `data: [DONE]`. |
| `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `seed`, `response_format` | **Silently ignored.** The CLI does not expose sampling controls, so rejecting these would break clients that always send them. |
| `tools`, `tool_choice`, `functions`, `function_call` | **Rejected** with `400 invalid_request_error`. |
| `n` | `n: 1` is ignored; `n` greater than 1 is **rejected** with `400 invalid_request_error`. |

### finish_reason mapping

| Claude `stop_reason` | OpenAI `finish_reason` |
|---|---|
| `end_turn` | `stop` |
| `stop_sequence` | `stop` |
| `max_tokens` | `length` |

### Example

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer csl_sk_..." \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 512,
    "messages": [
      { "role": "system", "content": "You are a concise assistant." },
      { "role": "user", "content": "Name three prime numbers." }
    ]
  }'
```

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1753600000,
  "model": "claude-sonnet-5",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "2, 3, and 5." },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 21,
    "completion_tokens": 9,
    "total_tokens": 30
  }
}
```

With `"stream": true` the response is a sequence of `data: {...}` chunks with `object: "chat.completion.chunk"`, ending with:

```text
data: [DONE]
```

## GET /v1/models

Returns the model ids the gateway advertises. The response uses the OpenAI models envelope (`object: "list"`, with `id`, `object`, `created` and `owned_by` per entry), which both SDK families accept:

```bash
curl https://gateway.example.com/v1/models -H "x-api-key: csl_sk_..."
```

These are the ids the gateway advertises for clients that probe the endpoint. `model` is not restricted to them: the aliases `sonnet`, `opus` and `haiku` and any `claude-*` id are also accepted, and an unrecognised value returns `400 invalid_request_error`.

## Errors

Both surfaces return the Anthropic error envelope:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "The final message must have role \"user\"."
  }
}
```

| Status | `error.type` | Meaning |
|---|---|---|
| 400 | `invalid_request_error` | Malformed body, unsupported field, rejected feature (tools, URL images). |
| 401 | `authentication_error` | Missing, malformed, or revoked API key. |
| 403 | `permission_error` | Valid key, operation not allowed. |
| 404 | `not_found_error` | Unknown route. An unrecognised `model` is a 400, not a 404. |
| 413 | `request_too_large` | Body exceeds the configured size limit. |
| 429 | `rate_limit_error` | The linked subscription hit its rate limit window. |
| 500 | `api_error` | Unexpected gateway failure. |
| 502 / 503 / 504 | `api_error` | Sandbox or upstream failure, unavailable, or timed out. |

Every response — success or error — carries an `X-Request-ID` header. Include it when reporting problems; logs are keyed by it and never contain request bodies or credentials.

## Client quickstarts

The gateway speaks both wire formats, so official SDKs work by overriding the base URL and key.

### curl

```bash
curl https://gateway.example.com/v1/messages \
  -H "x-api-key: csl_sk_..." \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

### @anthropic-ai/sdk (Node)

```js
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'https://gateway.example.com',
  apiKey: 'csl_sk_...',
});

const msg = await client.messages.create({
  model: 'claude-sonnet-5',
  max_tokens: 512,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### anthropic (Python)

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://gateway.example.com",
    api_key="csl_sk_...",
)

msg = client.messages.create(
    model="claude-sonnet-5",
    max_tokens=512,
    messages=[{"role": "user", "content": "Hello"}],
)
```

### openai (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gateway.example.com/v1",
    api_key="csl_sk_...",
)

resp = client.chat.completions.create(
    model="claude-sonnet-5",
    max_tokens=512,
    messages=[{"role": "user", "content": "Hello"}],
)
```

### openai (Node)

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://gateway.example.com/v1',
  apiKey: 'csl_sk_...',
});

const resp = await client.chat.completions.create({
  model: 'claude-sonnet-5',
  max_tokens: 512,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### Vercel AI SDK

```js
import { createAnthropic } from '@ai-sdk/anthropic';

const anthropic = createAnthropic({
  baseURL: 'https://gateway.example.com/v1',
  apiKey: 'csl_sk_...',
});
```

Then use `anthropic('claude-sonnet-5')` as the model in `generateText` / `streamText`. Tool calling will fail — the gateway rejects `tools`.

## Behavior differences from the real Anthropic API

- **One model turn per request.** The gateway flattens your entire `messages` history into a single prompt and sends exactly one user turn to the underlying CLI. There is no server-side conversation state; a 40-message history costs one turn but is re-sent (and re-tokenized) in full every request.
- **No tool use.** The sandbox runs with tools disabled. `tools`, `tool_use`, and `tool_result` are rejected, never emulated.
- **`max_tokens` is a soft clamp.** Values are clamped to 256–64000; a request for 10 is silently raised to 256, so responses may be longer than a strict reading of the request would allow.
- **Thinking blocks are hidden by default.** The underlying model may emit `thinking` content even when not asked. The gateway strips it unless the request includes `thinking`; when requested, thinking blocks (and their streaming deltas) pass through.
- **Token counts are approximate.** `usage` numbers come from the CLI's result event, not a billing meter. Treat them as estimates for budgeting, not accounting.
- **Requests are serialized per linked account.** Concurrent requests against the same key queue and run one at a time, so latency under parallel load grows linearly. This mirrors the single-session nature of the subscription underneath.
