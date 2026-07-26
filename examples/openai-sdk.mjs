// For apps already written against OpenAI. Note the /v1 suffix on baseURL: the OpenAI
// clients append their own paths, so the gateway root would 404 without it.
import OpenAI from 'openai';

const apiKey = process.env.CSL_KEY;
if (!apiKey) throw new Error('set CSL_KEY to your csl_sk_... gateway key');

const openai = new OpenAI({
  apiKey,
  baseURL: `${process.env.CSL_URL ?? 'http://127.0.0.1:3210'}/v1`,
});

const completion = await openai.chat.completions.create({
  model: 'claude-sonnet-5',
  messages: [
    { role: 'system', content: 'Answer in one word.' },
    { role: 'user', content: 'Largest planet in the solar system?' },
  ],
});
console.log('buffered :', completion.choices[0].message.content);
console.log('finish   :', completion.choices[0].finish_reason, '| tokens:', completion.usage.total_tokens);

process.stdout.write('streaming: ');
const stream = await openai.chat.completions.create({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'List three primary colors, comma separated.' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
console.log();
