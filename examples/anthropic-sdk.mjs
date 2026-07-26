// Official Anthropic SDK against your own gateway. Only apiKey and baseURL differ from
// talking to api.anthropic.com directly.
import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.CSL_KEY;
if (!apiKey) throw new Error('set CSL_KEY to your csl_sk_... gateway key');

const anthropic = new Anthropic({
  apiKey,
  baseURL: process.env.CSL_URL ?? 'http://127.0.0.1:3210',
});

const message = await anthropic.messages.create({
  model: 'claude-sonnet-5',
  max_tokens: 300,
  system: 'You are terse.',
  messages: [{ role: 'user', content: 'Explain a bloom filter in two sentences.' }],
});
console.log('buffered :', message.content.map((block) => block.text).join(''));
console.log('usage    :', message.usage.input_tokens, 'in /', message.usage.output_tokens, 'out');

process.stdout.write('streaming: ');
const stream = await anthropic.messages.stream({
  model: 'claude-sonnet-5',
  max_tokens: 300,
  messages: [{ role: 'user', content: 'Count from 1 to 10, space separated.' }],
});
stream.on('text', (text) => process.stdout.write(text));
await stream.finalMessage();
console.log();
