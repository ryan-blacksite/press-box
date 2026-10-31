/**
 * Purpose: write one team's Press Box stories, end to end, for the daily writer job (FV2-3 logic, moved out of the Worker and
 *   changed to ONE AI call per team with FV2-16).
 * Owns: buildTeamStories() (feed items -> clusters -> biggest first -> article text -> one AI call -> checked stories), the
 *   prompt, the reply parser, and the feed-snippet fall-backs.
 * Notes: One request asks for all of a team's stories at once (up to 3), which is what keeps a whole day of ~290 teams inside a free
 *   model's daily request limit. Each story the AI writes is checked by guard.ts; the ones that fail are asked for once more
 *   together, and any still failing become the feed's own headline and snippet, so a team is never left empty because the AI
 *   was sloppy. If the AI is not reachable at all, buildTeamStories reports `aiFailed` and the caller keeps yesterday's stories.
 *   The summary is written ONLY from article text the job fetched (at most two outlets per story); no article text is stored.
 *   FV2-47: the run reads every team's feeds and articles first (prepareTeam), then writes SEVERAL teams per AI request
 *   (buildTeamsBatch, buildBatchMessages): one request carries each team's numbered stories under a "TEAM:" heading and the reply
 *   numbers them straight through. Every story is still checked on its own, the failures of a whole batch are asked for once more
 *   together, and a story that still fails becomes the feed's headline, exactly as for a single team (buildTeamStories is a batch of one).
 *   FV2-154 item 6: only articles from a trusted English sports outlet (outlets.ts) are read, and the credit is that outlet's own name
 *   from the article's real address; stat pages and line-combination pages are skipped, not summarized; the prompt asks for what
 *   happened and nothing about the article, and guard.ts rejects a summary that talks about it (fallback: the headline alone).
 */
import { fetchArticle, isGoogleNewsLink } from './article';
import { stripTags } from './feeds';
import { isEnglishText, isNonStoryUrl, looksLikeStatsPage, type Trust } from './outlets';
import { APP_NAME } from './httpClient';
import { AiAuthError, AiBudgetError, AiUnavailableError, type AiClient, type ChatMessage } from './ai';
import { talksAboutTheArticle, validateSummary, type SummaryResult } from './guard';
import type { Cluster } from './rank';
import type { FeedItem, Story, StorySource } from './shared/types';
import type { PressBoxTeam } from './shared/teams';
import { isStoryForTeamSport, sportForLeague } from './shared/storySport';

const SOURCES_PER_STORY = 2;
/** Articles fetched per team per run. */
const MAX_ARTICLE_FETCHES = 8;
const MAX_ARTICLE_PROMPT_CHARS = 2_500;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function storyId(teamId: string, url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i += 1) hash = (hash * 31 + url.charCodeAt(i)) | 0;
  return `${teamId}-${(hash >>> 0).toString(36)}`;
}

/**
 * The feed's own blurb as a summary, or '' when it adds nothing. Google News's blurb is just the headline and
 * the outlet's name again, so it is empty here (the app then shows only the headline and its "Read the full
 * story" button); a real blurb (ESPN's) is kept. Never contains a link or markup.
 */
export function snippetFromItem(item: FeedItem): string {
  const blurb = stripTags(item.description).replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
  const lead = item.title.replace(/[.\s]+$/, '').toLowerCase();
  // Starts with the headline: what is left after it is at most the outlet's name, which adds nothing.
  if (lead && blurb.toLowerCase().startsWith(lead) && blurb.slice(lead.length).replace(/^[.\s:–—-]+/, '').length < 40) return '';
  if (blurb.length < 20 || talksAboutTheArticle(blurb).length > 0) return '';
  return blurb.slice(0, 900);
}

/** Headline + link + feed snippet when the article or the AI is unavailable. */
export function fallbackStoryFromItems(teamId: string, items: FeedItem[], now: number): Story {
  const sorted = [...items].sort((a, b) => {
    const googlePenalty = (item: FeedItem) => (isGoogleNewsLink(item.link) ? 1 : 0);
    return googlePenalty(a) - googlePenalty(b) || b.publishedAt - a.publishedAt;
  });
  const lead = sorted[0];
  const sources: StorySource[] = sorted.slice(0, SOURCES_PER_STORY).map((item) => ({ name: item.source, url: item.link }));
  const publishedAt = Math.max(...sorted.map((item) => item.publishedAt).filter(Boolean), now);
  return {
    id: storyId(teamId, lead.link),
    headline: lead.title,
    summary: snippetFromItem(lead),
    sources,
    url: lead.link,
    embeddable: false,
    publishedAt: new Date(publishedAt).toISOString(),
  };
}

export interface ReadArticle {
  source: string;
  url: string;
  text: string;
  embeddable: boolean;
  publishedAt: number;
}

export interface StoryInput {
  cluster: Cluster;
  /** Newest-first items with Google News links last. */
  items: FeedItem[];
  articles: ReadArticle[];
}

export function buildMessages(team: Pick<PressBoxTeam, 'name' | 'league'>, inputs: StoryInput[], objections: (string[] | null)[] = []): ChatMessage[] {
  const system = [
    `You write the "Press Box" for ${APP_NAME}, a sports-fan app. Summarize each numbered news story below for fans of the ${team.name} (${team.league}).`,
    'Use ONLY the article text provided for that story. Do not add any fact, number, name, date or quote that is not in that text. Do not use outside knowledge.',
    'Write in your own words. Never copy more than a few words in a row from an article, and never use a long quotation.',
    'If the articles disagree or only some of them say something, say "reports" or "according to reports" instead of stating it as certain.',
    'Each summary is 2 to 6 sentences: what happened and why it matters to the team and its fans. Say what is next only if the text says it. Shorter is fine: never pad to reach a length.',
    'State only what happened. NEVER write about the article or text itself or about what it leaves out: no "the article", "the text", "does not specify", "is not mentioned", "no information", "it is unclear from". If something is not in the text, leave it out of the summary; do not mention that it is missing.',
    `Each headline is a short, plain, factual headline in your own words, no clickbait, no trailing period. Write only about ${team.name}'s ${sportForLeague(team.league) ?? team.league} program; reject any source about another sport or a women's program and return no entry for it.`,
    'Reply with JSON only, no other text: {"stories": [{"n": 1, "headline": string, "summary": string}, ...]} with exactly one entry per story, using the story numbers given.',
  ].join('\n');
  const body = inputs
    .map((input, index) => {
      const articles = input.articles.map((article, i) => `--- Story ${index + 1}, article ${i + 1} (${article.source}) ---\n${article.text.slice(0, MAX_ARTICLE_PROMPT_CHARS)}`).join('\n\n');
      const fix = objections[index] && objections[index]!.length > 0 ? `\n[Your previous answer for story ${index + 1} was rejected: ${objections[index]!.join('; ')}. Fix exactly that.]` : '';
      return `${articles}${fix}`;
    })
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: body },
  ];
}

/** The model's JSON (it may wrap it in a code fence or add a sentence around it) as one result per requested story, null where missing or malformed. */
export function parseStoriesReply(content: string, count: number): (SummaryResult | null)[] {
  const out: (SummaryResult | null)[] = Array.from({ length: count }, () => null);
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return out;
  try {
    const json = JSON.parse(content.slice(start, end + 1)) as { stories?: unknown };
    if (!Array.isArray(json.stories)) return out;
    json.stories.forEach((entry: unknown, position: number) => {
      if (!entry || typeof entry !== 'object') return;
      const record = entry as Record<string, unknown>;
      if (typeof record.headline !== 'string' || typeof record.summary !== 'string') return;
      const n = Number(record.n);
      const index = Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : position;
      if (index < count && !out[index]) out[index] = { headline: record.headline.trim().replace(/\.$/, ''), summary: record.summary.trim() };
    });
  } catch {
    // Not JSON: every story is missing, and gets asked for again or falls back.
  }
  return out;
}

export interface TeamBuild {
  stories: Story[];
  aiCalls: number;
  aiStories: number;
  fallbackStories: number;
  articleFetches: number;
  /** The AI could not be used at all (every model failed, or the budget is spent): the caller keeps yesterday's stories. */
  aiFailed: boolean;
}

/** A team whose feeds and articles have been read and is ready to be written up. */
export interface PreparedTeam {
  team: PressBoxTeam;
  /** The team's clusters, biggest first. */
  ranked: Cluster[];
  /** Stories with article text: these go to the AI. */
  inputs: StoryInput[];
  /** Stories whose articles could not be read: they only ever become the feed's headline. */
  bare: StoryInput[];
  articleFetches: number;
}

/** Read the article text for a team's biggest stories (no AI yet). */
export async function prepareTeam(team: PressBoxTeam, ranked: Cluster[], wanted: number, fetcher: Fetcher, trust: Trust): Promise<PreparedTeam> {
  let articleFetches = 0;
  const inputs: StoryInput[] = [];
  const bare: StoryInput[] = [];

  for (const cluster of ranked.slice(0, wanted + 2)) {
    if (inputs.length >= wanted) break;
    const items = [...cluster.items].sort((a, b) => (isGoogleNewsLink(a.link) ? 1 : 0) - (isGoogleNewsLink(b.link) ? 1 : 0));
    const articles: ReadArticle[] = [];
    const seenOutlets = new Set<string>();
    for (const item of items) {
      if (articles.length >= SOURCES_PER_STORY || articleFetches >= MAX_ARTICLE_FETCHES) break;
      if (seenOutlets.has(item.source)) continue;
      articleFetches += 1;
      const article = await fetchArticle(item.link, fetcher);
      if (!article) continue;
      // The page actually read must be a trusted English sports outlet and a story; the credit is the outlet's own name for that address
      // (never the feed's free text), so an odd <source> can no longer be credited.
      const outlet = trust.outlet(article.url);
      if (!outlet || isNonStoryUrl(article.url) || looksLikeStatsPage(article.text) || !isEnglishText(article.text)) continue;
      if (seenOutlets.has(outlet)) continue;
      seenOutlets.add(outlet);
      articles.push({ source: outlet, url: article.url, text: article.text, embeddable: article.embeddable, publishedAt: item.publishedAt });
    }
    (articles.length > 0 ? inputs : bare).push({ cluster, items, articles });
  }
  return { team, ranked, inputs, bare, articleFetches };
}

/** The shared rules every request carries, whether it is for one team or several. */
function rulesFor(subject: string, sportRule: string): string {
  return [
    `You write the "Press Box" for ${APP_NAME}, a sports-fan app. Summarize each numbered news story below for fans of ${subject}.`,
    'Use ONLY the article text provided for that story. Do not add any fact, number, name, date or quote that is not in that text. Do not use outside knowledge.',
    'Write in your own words. Never copy more than a few words in a row from an article, and never use a long quotation.',
    'If the articles disagree or only some of them say something, say "reports" or "according to reports" instead of stating it as certain.',
    'Each summary is 2 to 6 sentences: what happened and why it matters to the team and its fans. Say what is next only if the text says it. Shorter is fine: never pad to reach a length.',
    'State only what happened. NEVER write about the article or text itself or about what it leaves out: no "the article", "the text", "does not specify", "is not mentioned", "no information", "it is unclear from". If something is not in the text, leave it out of the summary; do not mention that it is missing.',
    `Each headline is a short, plain, factual headline in your own words, no clickbait, no trailing period. ${sportRule}`,
    'Reply with JSON only, no other text: {"stories": [{"n": 1, "headline": string, "summary": string}, ...]} with exactly one entry per story, using the story numbers given.',
  ].join('\n');
}

/** One request for several teams: stories are numbered straight through, each team's under its own heading. `refs` is in request order. */
export interface BatchRef {
  /** Index into the batch's teams. */
  slot: number;
  /** Index into that team's inputs. */
  input: number;
}

export function buildBatchMessages(entries: { team: Pick<PressBoxTeam, 'name' | 'league'>; inputs: StoryInput[]; objections: (string[] | null)[]; which: number[] }[]): ChatMessage[] {
  const system = rulesFor(
    'the team named in each story\'s "TEAM:" heading',
    'Write each story only about that team\'s own program in the sport named in its heading; reject any source about another sport or a women\'s program and return no entry for it.',
  );
  let n = 0;
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.which.length === 0) continue;
    parts.push(`=== TEAM: ${entry.team.name} (${entry.team.league}, ${sportForLeague(entry.team.league) ?? entry.team.league}) ===`);
    for (const index of entry.which) {
      n += 1;
      const input = entry.inputs[index];
      const articles = input.articles.map((article, i) => `--- Story ${n}, article ${i + 1} (${article.source}) ---\n${article.text.slice(0, MAX_ARTICLE_PROMPT_CHARS)}`).join('\n\n');
      const problem = entry.objections[index];
      parts.push(`${articles}${problem && problem.length > 0 ? `\n[Your previous answer for story ${n} was rejected: ${problem.join('; ')}. Fix exactly that.]` : ''}`);
    }
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export interface BuildDeps {
  fetcher: Fetcher;
  /** Which outlets may be read and credited (outlets.ts). */
  trust: Trust;
  ai: AiClient;
  now: number;
}

/** Tokens a reply may use per team in a request (3 summaries of 4 to 6 sentences, plus headlines and the JSON around them). */
const TOKENS_PER_TEAM = 1_500;
const MAX_REPLY_TOKENS = 8_000;

/**
 * A team's stories from what the AI wrote for each input (`results`, null where it wrote nothing usable): the AI's story where
 * there is one, the feed's own headline and snippet where there is not. Biggest cluster first.
 */
function assembleStories(prepared: PreparedTeam, results: (SummaryResult | null)[], wanted: number, now: number): { stories: Story[]; aiStories: number; fallbackStories: number } {
  const { team, ranked, inputs, bare } = prepared;
  const stories: Story[] = [];
  let aiStories = 0;
  let fallbackStories = 0;
  const ordered = [...inputs.map((input, index) => ({ input, index })), ...bare.map((input) => ({ input, index: -1 }))].sort(
    (a, b) => ranked.indexOf(a.input.cluster) - ranked.indexOf(b.input.cluster),
  );
  for (const { input, index } of ordered) {
    if (stories.length >= wanted) break;
    const result = index >= 0 ? results[index] : null;
    if (result) {
      const lead = input.articles[0];
      stories.push({
        id: storyId(team.id, lead.url),
        headline: result.headline,
        summary: result.summary,
        sources: input.articles.map((article): StorySource => ({ name: article.source, url: article.url })),
        url: lead.url,
        embeddable: lead.embeddable,
        publishedAt: new Date(Math.max(...input.articles.map((article) => article.publishedAt), input.cluster.newestAt) || now).toISOString(),
      });
      aiStories += 1;
    } else if (input.items.length > 0) {
      stories.push(fallbackStoryFromItems(team.id, input.items, now));
      fallbackStories += 1;
    }
  }
  return { stories, aiStories, fallbackStories };
}

/**
 * Write several prepared teams with as few AI requests as possible: ONE request for all of their stories, and ONE more for the
 * stories that broke the rules. Never throws for an AI problem: every team in the batch gets `aiFailed` (an AiAuthError, a bad key,
 * is the one exception, because nothing after it can work). Results are in the order of `batch`.
 */
export async function buildTeamsBatch(batch: PreparedTeam[], wanted: number, deps: { ai: AiClient; now: number }): Promise<TeamBuild[]> {
  const { ai, now } = deps;
  const results = batch.map((prepared) => prepared.inputs.map((): SummaryResult | null => null));
  const problems = batch.map((prepared) => prepared.inputs.map((): string[] | null => null));
  const calls = batch.map(() => 0);
  let aiFailed = false;

  async function ask(refs: BatchRef[]): Promise<void> {
    const entries = batch.map((prepared, slot) => ({
      team: prepared.team,
      inputs: prepared.inputs,
      objections: problems[slot],
      which: refs.filter((ref) => ref.slot === slot).map((ref) => ref.input),
    }));
    // The numbering in the request follows batch order, then input order: the same order as `ordered`.
    const ordered = entries.flatMap((entry, slot) => entry.which.map((input): BatchRef => ({ slot, input })));
    const teamsAsked = new Set(ordered.map((ref) => ref.slot));
    teamsAsked.forEach((slot) => { calls[slot] += 1; });
    const reply = await ai.chat(buildBatchMessages(entries), { maxTokens: Math.min(MAX_REPLY_TOKENS, TOKENS_PER_TEAM * teamsAsked.size) });
    parseStoriesReply(reply.content, ordered.length).forEach((parsed, position) => {
      if (parsed) results[ordered[position].slot][ordered[position].input] = parsed;
    });
  }

  const check = (ref: BatchRef): boolean => {
    const { team, inputs } = batch[ref.slot];
    const result = results[ref.slot][ref.input];
    if (!result) {
      problems[ref.slot][ref.input] = ['it was missing or not valid JSON with "headline" and "summary"'];
      return false;
    }
    const issues = validateSummary(result, inputs[ref.input].articles.map((article) => article.text));
    if (!isStoryForTeamSport(result, team)) issues.push('it is about another sport or a women\'s program');
    problems[ref.slot][ref.input] = issues.length > 0 ? issues : null;
    if (issues.length > 0) results[ref.slot][ref.input] = null;
    return issues.length === 0;
  };

  const all = batch.flatMap((prepared, slot) => prepared.inputs.map((_, input): BatchRef => ({ slot, input })));
  if (all.length > 0) {
    try {
      await ask(all);
      const failed = all.filter((ref) => !check(ref));
      if (failed.length > 0) {
        // One more try for just the stories that broke the rules, with the objections.
        await ask(failed);
        failed.forEach((ref) => { check(ref); });
      }
    } catch (error) {
      if (error instanceof AiAuthError) throw error;
      if (error instanceof AiUnavailableError || error instanceof AiBudgetError) aiFailed = true;
      else throw error;
    }
  }

  return batch.map((prepared, slot) => {
    const { stories, aiStories, fallbackStories } = assembleStories(prepared, results[slot], wanted, now);
    return { stories, aiCalls: calls[slot], aiStories, fallbackStories, articleFetches: prepared.articleFetches, aiFailed: aiFailed && prepared.inputs.length > 0 };
  });
}

/**
 * The team's stories from its ranked clusters. `ranked` is biggest first. A batch of one team (see buildTeamsBatch). Never throws for
 * an AI problem: that is `aiFailed` (an AiAuthError, a bad key, is the one exception, because nothing after it can work).
 */
export async function buildTeamStories(team: PressBoxTeam, ranked: Cluster[], wanted: number, deps: BuildDeps): Promise<TeamBuild> {
  const prepared = await prepareTeam(team, ranked, wanted, deps.fetcher, deps.trust);
  const [build] = await buildTeamsBatch([prepared], wanted, { ai: deps.ai, now: deps.now });
  return build;
}
