/**
 * Purpose: compare OpenRouter's free models side by side on the same real articles, one-step and two-step, so the writer's model
 *   list is chosen from evidence (run from the "Model bench" workflow; never part of the hourly job).
 * Owns: the bench run: collect real stories (the writer's own feed, outlet, robots.txt and quality rules), ask each candidate model to
 *   write each story two ways, run the writer's own checks (guard.ts) on every answer, and print a table plus every summary.
 * Notes: Free models only (ids ending ":free", or openrouter/free). One-step = the writer's normal prompt. Two-step = first ask for the
 *   plain facts in the article, then write the story from ONLY those facts; the result is still checked against the real article text.
 *   Models run in parallel with each other (each has its own rate limit) and one after another within a model. Needs OPENROUTER_API_KEY
 *   only. Output goes to the log and to $GITHUB_STEP_SUMMARY. Nothing is stored anywhere.
 */
import { appendFileSync } from 'node:fs';
import { collectItems } from './feeds';
import { clusterItems, rankClusters } from './rank';
import { createRobotsFetcher } from './robots';
import { PRESS_BOX_USER_AGENT } from './httpClient';
import { trustFor } from './outlets';
import { TEAMS } from './shared/teams';
import { isStoryForTeamSport } from './shared/storySport';
import { buildBatchMessages, parseStoriesReply, prepareTeam, type StoryInput } from './stories';
import { validateSummary } from './guard';
import { cleanReply, type ChatMessage } from './ai';

const KEY = process.env.OPENROUTER_API_KEY ?? '';
const BASE = process.env.AI_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';
const MODELS = (process.env.BENCH_MODELS || 'google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free,thinkingmachines/inkling:free,openrouter/free')
  .split(',').map((id) => id.trim()).filter(Boolean);
const TEAM_IDS = (process.env.BENCH_TEAMS || 'nhl-stars,nfl-cowboys,nba-mavericks,mlb-rangers,nfl-lions,nhl-bruins').split(',').map((id) => id.trim());
const STORIES = Math.max(2, Number(process.env.BENCH_STORIES || 8));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (!KEY) throw new Error('OPENROUTER_API_KEY is not set');
for (const id of MODELS) if (!/:free$/.test(id) && id !== 'openrouter/free') throw new Error(`${id} is not a free model; the bench is free-only`);

interface Case { team: (typeof TEAMS)[number]; input: StoryInput }

async function collectCases(): Promise<Case[]> {
  const fetcher = createRobotsFetcher(fetch, PRESS_BOX_USER_AGENT);
  const trust = trustFor(undefined);
  const now = Date.now();
  const cases: Case[] = [];
  for (const id of TEAM_IDS) {
    const team = TEAMS.find((entry) => entry.id === id);
    if (!team) continue;
    const { items } = await collectItems(team, undefined, fetcher, now, trust);
    const prepared = await prepareTeam(team, rankClusters(clusterItems(items), now), 2, fetcher, trust);
    for (const input of prepared.inputs) cases.push({ team, input });
  }
  return cases.slice(0, STORIES);
}

interface Call { content: string; ms: number }

async function callModel(model: string, messages: ChatMessage[], maxTokens: number): Promise<Call | { error: string }> {
  const started = Date.now();
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-title': 'Press Box bench' },
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        await sleep(Number(res.headers.get('retry-after')) * 1_000 || 15_000 * attempt);
        continue;
      }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) return { content: cleanReply(content), ms: Date.now() - started };
      lastError = 'empty reply';
      await sleep(5_000);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(5_000);
    }
  }
  return { error: lastError || 'failed' };
}

const FACTS_SYSTEM = [
  'Read the article and list the facts it states, one per line, each starting with "- ".',
  'Copy names, numbers, scores, dates and records exactly as written. Add nothing: no inference, no opinion, no outside knowledge, no fact that is not in the text.',
  'Skip ads, navigation, bylines, and anything not about the news itself. At most 15 lines.',
].join('\n');

interface Outcome { ok: boolean; issues: string[]; headline: string; summary: string; ms: number; calls: number; error?: string }

async function runOne(model: string, strategy: 'one-step' | 'two-step', { team, input }: Case): Promise<Outcome> {
  const articleTexts = input.articles.map((article) => article.text);
  let ms = 0;
  let calls = 0;
  let source = input;
  if (strategy === 'two-step') {
    const facts: StoryInput['articles'] = [];
    for (const article of input.articles) {
      const reply = await callModel(model, [{ role: 'system', content: FACTS_SYSTEM }, { role: 'user', content: article.text.slice(0, 2_500) }], 700);
      calls += 1;
      if ('error' in reply) return { ok: false, issues: [`facts step: ${reply.error}`], headline: '', summary: '', ms, calls, error: reply.error };
      ms += reply.ms;
      facts.push({ ...article, text: reply.content });
    }
    source = { ...input, articles: facts };
  }
  const messages = buildBatchMessages([{ team, inputs: [source], objections: [null], which: [0] }]);
  const reply = await callModel(model, messages, 900);
  calls += 1;
  if ('error' in reply) return { ok: false, issues: [reply.error], headline: '', summary: '', ms, calls, error: reply.error };
  ms += reply.ms;
  const [parsed] = parseStoriesReply(reply.content, 1);
  if (!parsed) return { ok: false, issues: ['not valid JSON with headline and summary'], headline: '', summary: reply.content.slice(0, 200), ms, calls };
  // Always judged against the REAL article text, even when the writer only saw the extracted facts.
  const issues = validateSummary(parsed, articleTexts);
  if (!isStoryForTeamSport(parsed, team)) issues.push('about another sport or a women\'s program');
  return { ok: issues.length === 0, issues, headline: parsed.headline, summary: parsed.summary, ms, calls };
}

async function main(): Promise<void> {
  const cases = await collectCases();
  console.log(`bench: ${cases.length} stories, ${MODELS.length} models`);
  cases.forEach((entry, i) => console.log(`story ${i + 1}: ${entry.team.id} | ${entry.input.cluster.items[0]?.title} | ${entry.input.articles.map((a) => a.source).join(', ')}`));

  const rows: Record<string, Outcome[]> = {};
  await Promise.all(MODELS.map(async (model) => {
    for (const strategy of ['one-step', 'two-step'] as const) {
      const results: Outcome[] = [];
      for (const entry of cases) {
        results.push(await runOne(model, strategy, entry));
        await sleep(3_500);
      }
      rows[`${model} | ${strategy}`] = results;
    }
  }));

  const lines = ['### Model bench', '', `${cases.length} real stories; a story passes when the writer's own checks (numbers, names, claims, copying, length, sport, no talk about the article) find nothing wrong.`, '', '| model | method | passed | avg seconds | avg chars | calls | typical objections |', '|---|---|---|---|---|---|---|'];
  for (const [label, results] of Object.entries(rows)) {
    const [model, strategy] = label.split(' | ');
    const passed = results.filter((r) => r.ok).length;
    const timed = results.filter((r) => r.ms > 0);
    const seconds = timed.length ? (timed.reduce((sum, r) => sum + r.ms, 0) / timed.length / 1_000).toFixed(1) : '-';
    const chars = Math.round(results.filter((r) => r.summary).reduce((sum, r) => sum + r.summary.length, 0) / Math.max(1, results.filter((r) => r.summary).length));
    const objections = Array.from(new Set(results.flatMap((r) => r.issues).map((issue) => issue.replace(/[0-9]+/g, 'N').slice(0, 60)))).slice(0, 3).join('; ');
    lines.push(`| ${model} | ${strategy} | ${passed}/${results.length} | ${seconds} | ${chars} | ${results.reduce((s, r) => s + r.calls, 0)} | ${objections || '-'} |`);
  }
  const table = lines.join('\n');
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  for (const [label, results] of Object.entries(rows)) {
    results.forEach((r, i) => console.log(JSON.stringify({ event: 'bench-story', label, story: i + 1, ok: r.ok, issues: r.issues, headline: r.headline, summary: r.summary, seconds: Math.round(r.ms / 100) / 10 })));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
