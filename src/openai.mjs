// Streaming contract: createStreamAdapter({ id, model, created }) -> { first(), delta(text), last(stopReason) }; last() accepts an Anthropic stop_reason (or a pre-mapped OpenAI finish_reason) and emits the closing chunk.
import { PublicError, randomToken } from './security.mjs';

const FINISH_REASONS = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
};

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/;

function invalid(message) {
  return new PublicError(400, 'MESSAGES_INVALID', message);
}

function toolUseUnsupported() {
  return new PublicError(400, 'TOOL_USE_UNSUPPORTED', 'Tool and function calling are not supported by this gateway.');
}

function toBlock(part) {
  if (part?.type === 'text' && typeof part.text === 'string') {
    return { type: 'text', text: part.text };
  }
  if (part?.type === 'image_url') {
    const match = DATA_URL.exec(String(part.image_url?.url ?? ''));
    if (!match) {
      throw new PublicError(400, 'IMAGE_URL_UNSUPPORTED', 'Only data:<media-type>;base64 image URLs are supported; remote image URLs are not fetched.');
    }
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  }
  throw invalid('Message content parts must be text or image_url objects.');
}

function toContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(toBlock);
  throw invalid('Message content must be a string or an array of parts.');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
}

function hasItems(value) {
  return Array.isArray(value) ? value.length > 0 : value != null;
}

export function toAnthropicBody(body) {
  // SDKs commonly send tools: [] meaning "no tools"; only a real tool request is rejected.
  if (hasItems(body.tools) || hasItems(body.functions) || body.tool_choice != null) {
    throw toolUseUnsupported();
  }
  if (body.n != null && body.n > 1) {
    throw new PublicError(400, 'N_UNSUPPORTED', 'Only a single completion (n=1) is supported.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid('The messages field must be a non-empty array.');
  }

  const system = [];
  const messages = [];
  for (const message of body.messages) {
    const role = message?.role;
    if (role === 'system' || role === 'developer') {
      system.push(textOf(message.content));
    } else if (role === 'user' || role === 'assistant') {
      messages.push({ role, content: toContent(message.content) });
    } else if (role === 'tool' || role === 'function') {
      throw toolUseUnsupported();
    } else {
      throw invalid(`Unsupported message role: ${String(role)}.`);
    }
  }

  const anthropic = { model: body.model, messages };
  if (system.length > 0) anthropic.system = system.join('\n\n');
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) anthropic.max_tokens = maxTokens;
  if (body.stream != null) anthropic.stream = Boolean(body.stream);
  if (body.stop != null) anthropic.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return anthropic;
}

function chatId(id) {
  return `chatcmpl-${id ?? randomToken(12)}`;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

export function fromAnthropicMessage(message, { model, id, created } = {}) {
  const usage = message.usage ?? {};
  const promptTokens = (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0);
  const completionTokens = usage.output_tokens ?? 0;
  const content = (Array.isArray(message.content) ? message.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
  return {
    id: chatId(id),
    object: 'chat.completion',
    created: created ?? unixNow(),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: FINISH_REASONS[message.stop_reason] ?? 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export function createStreamAdapter({ id, model, created } = {}) {
  const base = { id: chatId(id), object: 'chat.completion.chunk', created: created ?? unixNow(), model };
  const chunk = (delta, finishReason = null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  return {
    first: () => chunk({ role: 'assistant', content: '' }),
    delta: (text) => chunk({ content: text }),
    last: (stopReason) => chunk({}, FINISH_REASONS[stopReason] ?? stopReason ?? 'stop'),
  };
}

export function modelsList(models, { created } = {}) {
  const stamp = created ?? unixNow();
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model?.id ?? model,
      object: 'model',
      created: stamp,
      owned_by: 'anthropic',
    })),
  };
}

export function openaiErrorBody(status, message, code) {
  const type = status === 429 ? 'rate_limit_error'
    : status === 401 || status === 403 ? 'authentication_error'
    : status >= 500 ? 'server_error'
    : 'invalid_request_error';
  return { error: { message, type, code: code ?? null, param: null } };
}
