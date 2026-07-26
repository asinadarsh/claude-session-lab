import { PublicError } from './security.mjs';
import { runClaudeStream } from './claude.mjs';
import { createResultCollector, streamEventsFor } from './messages.mjs';

const WINDOW_MS = 60000;

function extractApiKey(req) {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (match) return match[1];
  }
  return null;
}

export function createGateway({ keystore, config }) {
  const windows = new Map();
  const waiting = new Map();

  function checkRateLimit(id) {
    const now = Date.now();
    const hits = (windows.get(id) ?? []).filter((stamp) => now - stamp < WINDOW_MS);
    if (hits.length >= config.gateway.rateLimitPerMinute) {
      const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - hits[0])) / 1000));
      const error = new PublicError(429, 'RATE_LIMITED', `This key exceeded ${config.gateway.rateLimitPerMinute} requests per minute.`);
      error.retryAfter = retryAfter;
      throw error;
    }
    hits.push(now);
    windows.set(id, hits);
  }

  function enterQueue(id) {
    const depth = waiting.get(id) ?? 0;
    if (depth >= config.gateway.queueLimit) {
      const error = new PublicError(429, 'CONCURRENCY_LIMIT', 'Too many requests are already queued for this key. Requests run one at a time per linked account.');
      error.retryAfter = 5;
      throw error;
    }
    waiting.set(id, depth + 1);
  }

  function leaveQueue(id) {
    const depth = (waiting.get(id) ?? 1) - 1;
    if (depth <= 0) waiting.delete(id);
    else waiting.set(id, depth);
  }

  function authenticate(req) {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      throw new PublicError(401, 'API_KEY_MISSING', 'Provide your gateway key as x-api-key or Authorization: Bearer.');
    }
    const record = keystore.findByApiKey(apiKey);
    if (!record) {
      throw new PublicError(401, 'API_KEY_INVALID', 'That gateway key is not valid or has been revoked.');
    }
    return record;
  }

  /**
   * Runs one request end to end. `emit` is null for buffered responses; when supplied it is
   * called with (eventName, data) for every translated SSE event and must not throw.
   * Streaming callers get `committed: true` only once at least one event has been emitted,
   * so a failure before the first token can still be reported as a normal HTTP error.
   */
  async function run({ record, parsed, requestId, signal, emit = null }) {
    checkRateLimit(record.id);
    enterQueue(record.id);
    try {
      return await keystore.withLock(record.id, async () => {
        const tokens = await keystore.getTokens(record.id);
        const collector = createResultCollector({ includeThinking: parsed.includeThinking, model: parsed.model });
        const streamState = {};
        let committed = false;
        let failure = null;

        const { updatedTokens, aborted } = await runClaudeStream({
          tokens,
          cliInputLine: parsed.cliInputLine,
          model: parsed.model,
          systemPrompt: parsed.systemPrompt,
          maxTokens: parsed.maxTokens,
          binary: config.claudeBinary,
          timeoutMs: config.gateway.requestTimeoutMs,
          maxOutputBytes: config.maxClaudeOutputBytes,
          signal,
          onEvent: (obj) => {
            collector.push(obj);
            if (!emit) return;
            for (const { event, data } of streamEventsFor(obj, streamState, { includeThinking: parsed.includeThinking })) {
              committed = true;
              emit(event, data);
            }
          },
        });

        if (updatedTokens && updatedTokens.accessToken !== tokens.accessToken) {
          await keystore.updateTokens(record.id, updatedTokens);
        }

        const result = collector.result;
        if (!aborted) {
          if (!result) failure = new PublicError(502, 'CLAUDE_RESPONSE_INVALID', 'Claude returned an unreadable response. Retry once.');
          else if (result.is_error || result.subtype !== 'success') failure = cliFailure(result);
        }

        const usage = result?.usage ?? {};
        await keystore.recordUsage(record.id, {
          inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
          outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
          ok: !failure && !aborted,
        });

        if (aborted) return { aborted: true, committed, rateLimit: collector.rateLimit };
        if (failure) {
          failure.committed = committed;
          throw failure;
        }

        return {
          aborted: false,
          committed,
          rateLimit: collector.rateLimit,
          message: collector.toMessage({ requestId }),
          usage: {
            inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
            outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
          },
        };
      });
    } finally {
      leaveQueue(record.id);
    }
  }

  return { authenticate, run };
}

function cliFailure(result) {
  const message = String(result?.result ?? '').toLowerCase();
  const status = Number.isInteger(result?.api_error_status) ? result.api_error_status : null;
  if (status === 401 || message.includes('not logged in') || message.includes('unauthorized')) {
    return new PublicError(401, 'CLAUDE_AUTH_REQUIRED', 'The linked Claude account must be reconnected in the admin UI.');
  }
  if (status === 429 || message.includes('rate limit') || message.includes('usage limit')) {
    return new PublicError(429, 'CLAUDE_RATE_LIMITED', 'The linked Claude subscription hit its usage limit. Try again later.');
  }
  if (status === 400 || message.includes('too long') || message.includes('prompt is too long')) {
    return new PublicError(400, 'CLAUDE_REQUEST_REJECTED', 'Claude rejected this request. Shorten the conversation and retry.');
  }
  if (status === 529 || message.includes('overloaded')) {
    return new PublicError(503, 'CLAUDE_OVERLOADED', 'Claude is temporarily overloaded. Retry shortly.');
  }
  return new PublicError(502, 'CLAUDE_INFERENCE_FAILED', 'Claude could not complete this request. Retry once.');
}
