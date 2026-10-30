/**
 * Purpose: measure what the free AI models allow RIGHT NOW with the real key, so the schedule is set from facts, not guesses.
 * Owns: `npm run probe` (also the "Measure AI limits" workflow). Prints a markdown report; never prints the key.
 * Notes: Reads the key's tier and limits from OpenRouter's /key endpoint, then sends ONE tiny request to each listed free model and
 *   records the status, latency and any rate-limit headers. That is about a dozen requests, so run it by hand, not on a schedule.
 */
import { appendFileSync } from 'node:fs';
import { DEFAULT_FREE_MODELS } from './config';

const baseUrl = (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const apiKey = (process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();

async function main(): Promise<void> {
  if (!apiKey) {
    console.error('Set OPENROUTER_API_KEY (or AI_API_KEY).');
    process.exitCode = 1;
    return;
  }
  const auth = { authorization: `Bearer ${apiKey}` };
  const lines: string[] = ['## Free AI limits', ''];

  const keyRes = await fetch(`${baseUrl}/key`, { headers: auth }).catch(() => null);
  if (keyRes?.ok) {
    const data = ((await keyRes.json()) as { data?: Record<string, unknown> }).data ?? {};
    const shown = ['is_free_tier', 'limit', 'limit_remaining', 'usage', 'usage_daily', 'rate_limit'].filter((name) => name in data);
    lines.push('**Key** (from /key):', '', ...shown.map((name) => `- ${name}: \`${JSON.stringify(data[name])}\``), '');
  } else {
    lines.push(`**Key:** /key answered ${keyRes?.status ?? 'nothing'}.`, '');
  }

  const listRes = await fetch(`${baseUrl}/models`, { headers: auth }).catch(() => null);
  const listed = listRes?.ok ? new Set(((await listRes.json()) as { data?: { id: string }[] }).data?.map((model) => model.id) ?? []) : null;
  lines.push(`**Free models still listed:** ${listed ? DEFAULT_FREE_MODELS.filter((model) => listed.has(model) || model === 'openrouter/free').length : '?'} of ${DEFAULT_FREE_MODELS.length}`, '', '| model | status | ms | rate-limit headers |', '|---|---|---|---|');

  for (const model of DEFAULT_FREE_MODELS) {
    if (listed && model !== 'openrouter/free' && !listed.has(model)) {
      lines.push(`| ${model} | not listed | - | - |`);
      continue;
    }
    const started = Date.now();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 5 }),
    }).catch(() => null);
    const headers = res ? Array.from(res.headers as unknown as Iterable<[string, string]>).filter(([name]) => /ratelimit|retry-after/i.test(name)).map(([name, value]) => `${name}=${value}`).join(' ') : '';
    lines.push(`| ${model} | ${res?.status ?? 'no answer'} | ${Date.now() - started} | ${headers || '-'} |`);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
  }

  const report = lines.join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
}

void main();
