/**
 * Checks that the configured language models actually exist.
 *
 * Providers retire model names on their own schedule. When that happens every
 * conversational turn 404s, the interviewer answers with a neutral
 * acknowledgement, and the interview looks like it is running while producing
 * nothing worth scoring — so this is worth checking before an interview rather
 * than during one.
 *
 *   npm run verify:models
 */
import { z } from 'zod';
import { env } from '../src/lib/env';
import { complete, completeJson, FAST_MODEL, SMART_MODEL, providerLabel } from '../src/lib/ai';

const failures: string[] = [];

async function probe(role: string, model: string) {
  const started = Date.now();
  try {
    const reply = await complete({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
      maxTokens: 16,
    });
    console.log(`  PASS  ${role.padEnd(6)} ${model.padEnd(24)} ${String(Date.now() - started).padStart(5)}ms  ${JSON.stringify(reply.slice(0, 40))}`);
  } catch (err) {
    console.log(`  FAIL  ${role.padEnd(6)} ${model.padEnd(24)} ${(err as Error).message.slice(0, 120)}`);
    failures.push(`${role} model "${model}"`);
  }
}

async function probeJson(role: string, model: string) {
  const started = Date.now();
  const schema = z.object({ acknowledgement: z.string(), followUp: z.string().nullable() });
  try {
    const out = await completeJson({
      model,
      schema,
      retries: 1,
      messages: [
        { role: 'system', content: 'You are an interviewer. Reply with JSON only.' },
        {
          role: 'user',
          content:
            'The candidate said they used Redis for caching. Respond with a single JSON object of exactly this shape:\n' +
            '{\n  "acknowledgement": "one short spoken line",\n  "followUp": "a question, or null"\n}',
        },
      ],
    });
    console.log(`  PASS  ${role.padEnd(6)} ${model.padEnd(24)} ${String(Date.now() - started).padStart(5)}ms  ${JSON.stringify(out.acknowledgement.slice(0, 40))}`);
  } catch (err) {
    console.log(`  FAIL  ${role.padEnd(6)} ${model.padEnd(24)} ${(err as Error).message.slice(0, 120)}`);
    failures.push(`${role} model "${model}" cannot produce valid JSON`);
  }
}

async function main() {
  console.log(`Routing: ${providerLabel}\n`);

  console.log('1. A plain turn on each configured model');
  await probe('fast', FAST_MODEL);
  if (SMART_MODEL !== FAST_MODEL) await probe('smart', SMART_MODEL);

  console.log('\n2. Structured output, which every scored turn depends on');
  await probeJson('fast', FAST_MODEL);
  if (SMART_MODEL !== FAST_MODEL) await probeJson('smart', SMART_MODEL);

  // The recovery path itself. A name no provider serves must land on the other
  // provider rather than costing three retries and a neutral acknowledgement.
  console.log('\n3. A retired model name falls over to the other provider');
  if (env.LLM_PROVIDER !== 'auto') {
    console.log(`  SKIP  LLM_PROVIDER is pinned to ${env.LLM_PROVIDER}, so crossing providers is disabled by choice`);
  } else if (!env.GROQ_API_KEY || !env.MISTRAL_API_KEY) {
    console.log('  SKIP  only one provider is configured, so there is nothing to fall over to');
  } else {
    const started = Date.now();
    try {
      const reply = await complete({
        model: 'a-model-that-was-retired',
        messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
        maxTokens: 16,
      });
      console.log(`  PASS  ${String(Date.now() - started).padStart(5)}ms  answered anyway: ${JSON.stringify(reply.slice(0, 40))}`);
    } catch (err) {
      console.log(`  FAIL  ${(err as Error).message.slice(0, 160)}`);
      failures.push('a retired model name did not fall over to the other provider');
    }
  }

  console.log(
    failures.length
      ? `\n${failures.length} problem(s):\n  - ${failures.join('\n  - ')}\n\n` +
          'Check the provider console for names the account can use, then set\n' +
          'GROQ_FAST_MODEL / GROQ_SMART_MODEL (or the MISTRAL_ equivalents) in .env.'
      : '\nMODELS OK',
  );
  process.exit(failures.length ? 1 : 0);
}

void main();
