// A real chat app keeps the whole message array and resends it every turn. The gateway
// flattens that history into a single prompt, so each turn costs one model turn no matter
// how long the thread gets.
import { createInterface } from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.CSL_KEY;
if (!apiKey) throw new Error('set CSL_KEY to your csl_sk_... gateway key');

const anthropic = new Anthropic({
  apiKey,
  baseURL: process.env.CSL_URL ?? 'http://127.0.0.1:3210',
});

const messages = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log('Chat with your subscription. Blank line or Ctrl-C to quit.\n');

for (;;) {
  let input;
  try {
    input = (await rl.question('you: ')).trim();
  } catch {
    break; // stdin closed: Ctrl-D, or piped input ran out
  }
  if (!input) break;
  messages.push({ role: 'user', content: input });

  process.stdout.write('claude: ');
  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages,
  });
  stream.on('text', (text) => process.stdout.write(text));
  const reply = await stream.finalMessage();
  console.log('\n');

  // Keeping the assistant turn is what makes the next question aware of this one.
  messages.push({ role: 'assistant', content: reply.content.map((block) => block.text ?? '').join('') });
}
rl.close();
