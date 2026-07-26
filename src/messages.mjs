import { PublicError, randomToken } from './security.mjs';

const MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku']);
const MODEL_ID_PATTERN = /^claude-[a-z0-9][a-z0-9.-]{0,63}$/i;
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']);
const ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'overloaded_error',
]);
const TRANSCRIPT_FRAMING = 'This is the prior conversation between Human and Assistant. Continue it by responding to the final Human message below.';

export function resolveModel(model) {
  if (model === undefined || model === null || model === '') return 'sonnet';
  if (typeof model === 'string' && (MODEL_ALIASES.has(model) || MODEL_ID_PATTERN.test(model))) {
    return model;
  }
  throw new PublicError(400, 'MODEL_INVALID', 'model must be sonnet, opus, haiku, or a claude-* model id.');
}

function invalidMessages(publicMessage) {
  return new PublicError(400, 'MESSAGES_INVALID', publicMessage);
}

function rejectToolBlocks(block) {
  if (block.type === 'tool_use' || block.type === 'tool_result') {
    throw new PublicError(400, 'TOOL_USE_UNSUPPORTED', 'tool_use and tool_result blocks are not supported by this gateway.');
  }
}

function textFromBlock(block) {
  if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
    throw invalidMessages('Content blocks must be objects with a type.');
  }
  rejectToolBlocks(block);
  if (block.type === 'text') {
    if (typeof block.text !== 'string') throw invalidMessages('Text blocks need a string text field.');
    return block.text;
  }
  if (block.type === 'image') return null;
  throw invalidMessages(`Unsupported content block type "${block.type}".`);
}

function transcriptText(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const block of content) {
    const text = textFromBlock(block);
    parts.push(text === null ? '[image omitted]' : text);
  }
  return parts.join('\n');
}

function validateImageBlock(block, limits) {
  const source = block.source;
  if (!source || typeof source !== 'object') {
    throw new PublicError(400, 'IMAGE_INVALID', 'Image blocks need a base64 source object.');
  }
  if (source.type === 'url') {
    throw new PublicError(400, 'IMAGE_URL_UNSUPPORTED', 'URL image sources are not supported; send base64 data instead.');
  }
  if (source.type !== 'base64') {
    throw new PublicError(400, 'IMAGE_INVALID', 'Image sources must use type "base64".');
  }
  if (!IMAGE_MEDIA_TYPES.has(source.media_type)) {
    throw new PublicError(400, 'IMAGE_MEDIA_TYPE_INVALID', 'Images must be image/png, image/jpeg, image/gif, or image/webp.');
  }
  const data = source.data;
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new PublicError(400, 'IMAGE_BASE64_INVALID', 'Image data must be well-formed base64.');
  }
  const decodedBytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (decodedBytes > limits.maxImageBytes) {
    throw new PublicError(413, 'IMAGE_TOO_LARGE', `Each image must decode to at most ${limits.maxImageBytes} bytes.`);
  }
  return { type: 'image', source: { type: 'base64', media_type: source.media_type, data } };
}

function finalUserContent(content, limits) {
  if (typeof content === 'string') return { text: content, images: [] };
  const parts = [];
  const images = [];
  for (const block of content) {
    const text = textFromBlock(block);
    if (text !== null) {
      parts.push(text);
      continue;
    }
    if (images.length >= limits.maxImages) {
      throw new PublicError(400, 'TOO_MANY_IMAGES', `At most ${limits.maxImages} images are allowed per request.`);
    }
    images.push(validateImageBlock(block, limits));
  }
  return { text: parts.join('\n'), images };
}

function flattenSystem(system) {
  if (system === undefined || system === null) return null;
  if (typeof system === 'string') return system || null;
  if (Array.isArray(system)) {
    const parts = [];
    for (const block of system) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') {
        throw new PublicError(400, 'SYSTEM_INVALID', 'system blocks must be text blocks.');
      }
      parts.push(block.text);
    }
    return parts.join('\n\n') || null;
  }
  throw new PublicError(400, 'SYSTEM_INVALID', 'system must be a string or an array of text blocks.');
}

export function parseMessagesRequest(body, limits) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidMessages('The request body must be a JSON object.');
  }
  const model = resolveModel(body.model);
  // Silently ignoring tools would leave the caller waiting for a tool_use block that can
  // never arrive, so declared tools are refused outright. Empty arrays are what some SDKs
  // send by default and mean "no tools".
  if ((Array.isArray(body.tools) && body.tools.length > 0) || body.tool_choice !== undefined) {
    throw new PublicError(400, 'TOOL_USE_UNSUPPORTED', 'This gateway runs with tools disabled; remove tools and tool_choice.');
  }
  const systemPrompt = flattenSystem(body.system);
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalidMessages('messages must be a non-empty array.');
  }
  if (messages.length > limits.maxMessages) {
    throw invalidMessages(`messages may contain at most ${limits.maxMessages} entries.`);
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object' || (message.role !== 'user' && message.role !== 'assistant')) {
      throw invalidMessages('Every message needs role "user" or "assistant".');
    }
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
      throw invalidMessages('Message content must be a string or an array of content blocks.');
    }
  }
  if (messages[messages.length - 1].role !== 'user') {
    throw invalidMessages('The final message must have role "user".');
  }

  const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0
    ? Math.min(64000, Math.max(256, body.max_tokens))
    : (limits?.defaultMaxTokens ?? 4096);
  const stream = body.stream === true;
  const includeThinking = body.thinking?.type === 'enabled';

  // The CLI exposes no stop-sequence control, and accepting the field would silently let
  // generation run past the caller's delimiter while still reporting stop_reason 'end_turn'.
  // Refusing it is the same choice made for tools: fail loudly rather than mislead.
  if (Array.isArray(body.stop_sequences) ? body.stop_sequences.length > 0 : body.stop_sequences !== undefined && body.stop_sequences !== null) {
    throw new PublicError(400, 'STOP_SEQUENCES_UNSUPPORTED', 'Stop sequences are not supported by this gateway (stop_sequences, or stop on the OpenAI surface); trim the response on your side.');
  }

  const transcriptParts = [];
  for (const message of messages.slice(0, -1)) {
    const label = message.role === 'user' ? 'Human' : 'Assistant';
    transcriptParts.push(`${label}: ${transcriptText(message.content)}`);
  }
  const final = finalUserContent(messages[messages.length - 1].content, limits);
  // Checked against the final message alone. Once a transcript preamble is prepended the
  // combined text is never empty, so a caption-less image or an empty string would otherwise
  // be flattened into a prompt that just ends on the assistant's previous turn.
  if (final.text.length === 0 && final.images.length === 0) {
    throw invalidMessages('The final user message needs text or image content.');
  }

  let historyChars = 0;
  let promptText = final.text;
  if (transcriptParts.length > 0) {
    const preamble = `${TRANSCRIPT_FRAMING}\n\n${transcriptParts.join('\n\n')}\n\n`;
    historyChars = preamble.length;
    // A caption-less image is a normal chat shape, but appended to a transcript it would leave
    // the prompt ending on the assistant's own turn with no new request to answer.
    promptText = preamble + (final.text || 'Human: (image attached with no caption)');
  }
  if (promptText.length > limits.maxPromptChars) {
    throw new PublicError(413, 'PROMPT_TOO_LARGE', `The flattened prompt exceeds ${limits.maxPromptChars} characters.`);
  }

  const blocks = [...final.images];
  if (promptText.length > 0) blocks.push({ type: 'text', text: promptText });
  if (blocks.length === 0) {
    throw invalidMessages('The final user message needs text or image content.');
  }

  return {
    model,
    systemPrompt,
    cliInputLine: JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }),
    stream,
    maxTokens,
    includeThinking,
    historyChars,
  };
}

function usageInt(value) {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function isThinkingBlock(block) {
  return block.type === 'thinking' || block.type === 'redacted_thinking';
}

export function createResultCollector({ includeThinking = false, model = null } = {}) {
  let rateLimit = null;
  let result = null;
  let reportedModel = null;
  let assistantStopReason = null;
  const blocks = [];
  return {
    push(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (obj.type === 'rate_limit_event' && obj.rate_limit_info && typeof obj.rate_limit_info === 'object') {
        rateLimit = obj.rate_limit_info;
      } else if (obj.type === 'result') {
        result = obj;
      } else if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block && typeof block === 'object' && typeof block.type === 'string') blocks.push(block);
        }
        if (typeof obj.message.model === 'string' && obj.message.model) reportedModel = obj.message.model;
        if (typeof obj.message.stop_reason === 'string') assistantStopReason = obj.message.stop_reason;
      }
    },
    get rateLimit() {
      return rateLimit;
    },
    get result() {
      return result;
    },
    toMessage({ requestId } = {}) {
      let content = blocks.filter((block) => includeThinking || !isThinkingBlock(block));
      if (content.length === 0) {
        content = [{ type: 'text', text: typeof result?.result === 'string' ? result.result : '' }];
      }
      const rawStopReason = result?.stop_reason ?? assistantStopReason;
      const cliModel = reportedModel
        ?? (result?.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage)[0] : null);
      const usage = result?.usage && typeof result.usage === 'object' ? result.usage : {};
      return {
        id: `msg_${requestId ?? randomToken(12)}`,
        type: 'message',
        role: 'assistant',
        model: cliModel ?? model ?? 'unknown',
        content,
        stop_reason: STOP_REASONS.has(rawStopReason) ? rawStopReason : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: usageInt(usage.input_tokens),
          output_tokens: usageInt(usage.output_tokens),
          cache_read_input_tokens: usageInt(usage.cache_read_input_tokens),
          cache_creation_input_tokens: usageInt(usage.cache_creation_input_tokens),
        },
      };
    },
  };
}

export function streamEventsFor(obj, state, { includeThinking = false } = {}) {
  try {
    if (!obj || typeof obj !== 'object' || obj.type !== 'stream_event') return [];
    const event = obj.event;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return [];
    if (includeThinking) return [{ event: event.type, data: event }];
    if (!state.suppressedBlocks) {
      state.suppressedBlocks = new Set();
      state.blockIndexMap = new Map();
      state.nextBlockIndex = 0;
    }
    if (event.type === 'content_block_start') {
      if (isThinkingBlock(event.content_block ?? {})) {
        state.suppressedBlocks.add(event.index);
        return [];
      }
      const mapped = { ...event, index: state.nextBlockIndex };
      state.blockIndexMap.set(event.index, state.nextBlockIndex);
      state.nextBlockIndex += 1;
      return [{ event: event.type, data: mapped }];
    }
    if (event.type === 'content_block_delta' || event.type === 'content_block_stop') {
      if (state.suppressedBlocks.has(event.index)) return [];
      const data = state.blockIndexMap.has(event.index)
        ? { ...event, index: state.blockIndexMap.get(event.index) }
        : event;
      return [{ event: event.type, data }];
    }
    return [{ event: event.type, data: event }];
  } catch {
    return [];
  }
}

export function sseChunk(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function anthropicErrorBody(type, message) {
  return {
    type: 'error',
    error: {
      type: ERROR_TYPES.has(type) ? type : 'api_error',
      message: String(message ?? ''),
    },
  };
}

export function errorTypeForStatus(status) {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  return status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error';
}
