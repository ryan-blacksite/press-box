/**
 * FV2-16: the Press Box writer job (scripts/press-box, run by .github/workflows/press-box.yml). Who is covered, the feeds,
 * ranking, article reading and AI guardrails (moved here from the Worker, FV2-3), the free-model AI client (pacing, backoff,
 * model fall-back, budget), the Cloudflare KV client, one team's stories, and a whole run (skip without news, keep yesterday,
 * after-game, dry run). The network, the AI and KV are faked; the live feeds can't be reached from CI, so every parser is pinned
 * against a representative fixture.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAMS } from '../src/shared/teams';
import { collectItems, espnFeedUrl, espnTeamNewsUrl, googleNewsUrl, mentionsTeam, nickname, parseEspnTeamNews, parseFeed, stripTags } from '../src/feeds';
import { clusterItems, rankClusters, similarity, titleTokens } from '../src/rank';
import { decodeEmbeddedGoogleUrl, extractArticleText, isEmbeddable } from '../src/article';
import { longestSharedRun, sentenceCount, unsupportedNumbers, validateSummary } from '../src/guard';
import { buildMessages, buildTeamStories, fallbackStoryFromItems, parseStoriesReply, snippetFromItem } from '../src/stories';
import { AiAuthError, AiBudgetError, AiUnavailableError, DEAD_MODEL_MS, cleanReply, createAiClient, resolveModels, type AiClient, type ChatMessage } from '../src/ai';
import { createKv, KvError, TEAM_TTL_S, teamKey } from '../src/kv';
import { bundleKey, parseBundle, serializeBundle } from '../src/shared/bundle';
import { ConfigError, DEFAULT_FREE_MODELS, DEFAULT_KV_NAMESPACE_ID, loadConfig } from '../src/config';
import { completedAbbreviations, easternDay, finishedTeamIds, scoreboardUrl } from '../src/afterGame';
import { aiWarning, coveredTeams, exitCodeFor, formatSummary, runPressBox, RETRY_PASSES, type RunSummary } from '../src/run';
import type { FeedItem, TeamStories } from '../src/shared/types';
import { trustFor } from '../src/outlets';

/** The built-in allowlist only (no team-site feeds, no extras). */
const TRUST = trustFor(undefined);

const LIONS = TEAMS.find((team) => team.id === 'nfl-lions')!;
const NOW = Date.parse('2026-10-15T14:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toUTCString();

// ---- fixtures -----------------------------------------------------------------------------------

const GOOGLE_RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Lions place star pass rusher on injured reserve - Detroit Free Press</title><link>https://news.google.com/rss/articles/CBMiAAAA?oc=5</link><pubDate>${hoursAgo(3)}</pubDate><description>&lt;a href="x"&gt;Lions place star pass rusher on injured reserve&lt;/a&gt;</description><source url="https://www.freep.com">Detroit Free Press</source></item>
<item><title>Detroit Lions sign veteran edge rusher after injury news - ESPN</title><link>https://news.google.com/rss/articles/CBMiBBBB?oc=5</link><pubDate>${hoursAgo(2)}</pubDate><description>x</description><source url="https://www.espn.com">ESPN</source></item>
<item><title>Lions fans plan tailgate - The Athletic</title><link>https://news.google.com/rss/articles/CBMiCCCC?oc=5</link><pubDate>${hoursAgo(30)}</pubDate><description>x</description><source url="https://theathletic.com">The Athletic</source></item>
<item><title>Ancient Lions story</title><link>https://example.com/old</link><pubDate>${hoursAgo(24 * 9)}</pubDate><description>x</description><source url="https://example.com">Old Outlet</source></item>
</channel></rss>`;

const ESPN_RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Detroit Lions put edge rusher on IR, sign veteran]]></title><link>https://www.espn.com/nfl/story/_/id/1/lions-ir</link><pubDate>${hoursAgo(2)}</pubDate><description><![CDATA[<p>The Lions made two moves Wednesday.</p>]]></description></item>
<item><title>Packers sign a kicker</title><link>https://www.espn.com/nfl/story/_/id/2/packers</link><pubDate>${hoursAgo(1)}</pubDate><description>Green Bay moves.</description></item>
</channel></rss>`;

const ESPN_TEAM_JSON = JSON.stringify({
  articles: [
    {
      headline: 'Detroit Lions put edge rusher on IR, sign veteran',
      description: 'The Lions made two roster moves on Wednesday.',
      published: hoursAgo(2),
      links: { web: { href: 'https://www.espn.com/nfl/story/_/id/1/lions-ir' } },
    },
    {
      headline: 'Packers sign a kicker',
      description: 'Green Bay moves.',
      published: hoursAgo(1),
      links: { web: { href: 'https://www.espn.com/nfl/story/_/id/2/packers' } },
    },
  ],
});

const PARAGRAPHS = [
  'The Detroit Lions placed their top pass rusher on injured reserve on Wednesday after he left Sunday\'s game with a knee injury, the team announced.',
  'Coach Dan Campbell said the injury will keep the defensive end out for at least four games, and that the team expects him back before the end of the regular season.',
  'The move opens a roster spot, which the club filled by signing a veteran edge rusher who had been released by another team earlier this month.',
  'Detroit enters the weekend with a 5-1 record and a defense that has recorded 18 sacks, tied for the league lead through six games.',
  'The Lions host their next game at Ford Field, where the front seven will have to adjust without its leading sack producer in the lineup.',
].map((text) => `<p>${text}</p>`).join('\n');
const ARTICLE_HTML = (extra = '') => `<html><head><script type="application/ld+json">{"@type":"WebSite"}</script></head><body><nav><p>Home | Scores | Sign up for our newsletter today please</p></nav><article>${PARAGRAPHS}${extra}</article><footer><p>Copyright. All rights reserved by the company that owns this website always.</p></footer></body></html>`;

const GOOD_SUMMARY = {
  headline: 'Lions put top pass rusher on injured reserve',
  summary: 'Detroit has moved its leading pass rusher to injured reserve following a knee problem suffered in the weekend game. Coach Dan Campbell reportedly expects the defensive end to miss a minimum of four games. The team responded by adding a veteran edge player who was cut elsewhere this month. That matters because the Lions are 5-1 and share the league lead with 18 sacks, so the line must adjust. Next up is the home game at Ford Field, where the pass rush will be tested without him.',
};

// ---- who is covered -----------------------------------------------------------------------------

describe('coverage', () => {
  it('covers the teams in the teams file (the FLY list: 290 teams in seven leagues)', () => {
    const covered = coveredTeams();
    expect(covered).toHaveLength(290);
    for (const league of ['NFL', 'NBA', 'NHL', 'MLB', 'MLS', 'NCAAF', 'NCAAMB']) expect(covered.some((team) => team.league === league)).toBe(true);
    expect(covered.filter((team) => team.league === 'NCAAF')).toHaveLength(68);
    expect(covered.filter((team) => team.league === 'NCAAMB')).toHaveLength(68);
    expect(new Set(covered.map((team) => team.id)).size).toBe(covered.length);
  });
});

// ---- feeds --------------------------------------------------------------------------------------

describe('feeds', () => {
  it('parses Google News items: strips the publisher suffix, reads the source and the date', () => {
    const items = parseFeed(GOOGLE_RSS, 'google', 'Google News');
    expect(items[0]).toMatchObject({ title: 'Lions place star pass rusher on injured reserve', source: 'Detroit Free Press', feed: 'google' });
    expect(items[0].publishedAt).toBe(Date.parse(hoursAgo(3)));
    expect(items[0].description).toContain('Lions place star pass rusher');
  });

  it('parses ESPN items with CDATA and no source element', () => {
    const items = parseFeed(ESPN_RSS, 'espn', 'ESPN');
    expect(items[0]).toMatchObject({ title: 'Detroit Lions put edge rusher on IR, sign veteran', source: 'ESPN', link: 'https://www.espn.com/nfl/story/_/id/1/lions-ir' });
    expect(items[0].description).toBe('The Lions made two moves Wednesday.');
  });

  it('reads Atom entries and ignores items without a usable link', () => {
    const atom = '<feed><entry><title>Team news</title><link href="https://team.example/a"/><updated>2026-10-15T10:00:00Z</updated></entry><entry><title>No link</title></entry></feed>';
    expect(parseFeed(atom, 'team', 'Team').map((item) => item.link)).toEqual(['https://team.example/a']);
    expect(parseFeed('not xml at all', 'google', 'x')).toEqual([]);
  });

  it('knows a team by full name or whole-word nickname, and not by a lookalike', () => {
    expect(nickname(LIONS)).toBe('Lions');
    expect(mentionsTeam('Detroit Lions sign a kicker', LIONS)).toBe(true);
    expect(mentionsTeam('Lions roar back', LIONS)).toBe(true);
    expect(mentionsTeam('Packers sign a kicker', LIONS)).toBe(false);
    expect(mentionsTeam('Billions at stake', LIONS)).toBe(false);
    expect(nickname(TEAMS.find((team) => team.id === 'nba-trail-blazers') ?? LIONS)).toBeTruthy();
  });

  it('builds the Google and ESPN URLs', () => {
    expect(googleNewsUrl(LIONS)).toContain('news.google.com/rss/search?q=%22Detroit%20Lions%22%20football%20when%3A3d');
    expect(espnFeedUrl(LIONS)).toBe('https://www.espn.com/espn/rss/nfl/news');
    expect(espnTeamNewsUrl(LIONS)).toBe('https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/news?team=det');
    expect(espnFeedUrl({ ...LIONS, league: 'F1' })).toBeNull();
  });

  it('parses ESPN team JSON news', () => {
    const items = parseEspnTeamNews(ESPN_TEAM_JSON);
    expect(items[0]).toMatchObject({ title: 'Detroit Lions put edge rusher on IR, sign veteran', feed: 'espn', source: 'ESPN' });
    expect(items[0].description).toContain('two roster moves');
  });

  it('collects recent, on-team items from every feed that answers, and survives one being down', async () => {
    const issues: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('news.google.com')) return new Response(GOOGLE_RSS, { status: 200 });
      throw new Error('espn is down');
    });
    const { items } = await collectItems(LIONS, undefined, fetcher as unknown as typeof fetch, NOW, TRUST, (m) => issues.push(m));
    // The nine-day-old item is dropped; the rest survive.
    expect(items.map((item) => item.source)).toEqual(['Detroit Free Press', 'ESPN', 'The Athletic']);
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it('filters ESPN’s league-wide feed to the team', async () => {
    const fetcher = vi.fn(async (url: string) => new Response(url.includes('espn') ? ESPN_RSS : '<rss></rss>', { status: 200 }));
    const { items } = await collectItems(LIONS, undefined, fetcher as unknown as typeof fetch, NOW, TRUST);
    expect(items.map((item) => item.title)).toEqual(['Detroit Lions put edge rusher on IR, sign veteran']);
  });

  it('turns Google News\'s entity-escaped description into plain words, never markup (FV2-9)', () => {
    const xml = `<rss><channel><item><title>Lions fan posts video about Dan Campbell - Cleveland.com</title><link>https://news.google.com/rss/articles/CBMi?oc=5</link><pubDate>Thu, 15 Oct 2026 12:00:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMi?oc=5" target="_blank"&gt;Lions fan posts video about Dan Campbell&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Cleveland.com&lt;/font&gt;</description><source url="https://www.cleveland.com">Cleveland.com</source></item></channel></rss>`;
    const [item] = parseFeed(xml, 'google', 'Google News');
    expect(item.description).toBe('Lions fan posts video about Dan Campbell Cleveland.com');
    expect(item.description).not.toMatch(/[<>]|href|&nbsp;|https?:/);
  });

  it('keeps a real "3 < 5" comparison when stripping tags (FV2-9)', () => {
    expect(stripTags('Score 3 < 5 and a <b>big</b> win')).toBe('Score 3 < 5 and a big win');
  });
});

// ---- ranking ------------------------------------------------------------------------------------

describe('ranking', () => {
  const item = (title: string, source: string, hours: number, feed: FeedItem['feed'] = 'google'): FeedItem => ({ title, link: `https://x.test/${title}`, publishedAt: NOW - hours * 3_600_000, source, description: '', feed });

  it('groups the same story from different outlets and ranks the widely covered one first', () => {
    const clusters = rankClusters(
      clusterItems([
        item('Lions place pass rusher on injured reserve', 'Freep', 3),
        item('Detroit Lions put pass rusher on injured reserve', 'ESPN', 2),
        item('Lions pass rusher on injured reserve, team says', 'The Athletic', 4),
        item('Lions fans plan tailgate', 'Local Blog', 1),
      ]),
      NOW,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0].outlets.sort()).toEqual(['ESPN', 'Freep', 'The Athletic']);
  });

  it('does not merge different stories and measures overlap against the shorter headline', () => {
    expect(similarity(titleTokens('Lions sign kicker'), titleTokens('Lions trade quarterback to Packers'))).toBeLessThan(0.6);
    expect(similarity(titleTokens('Lions place rusher on injured reserve'), titleTokens('Lions rusher injured reserve'))).toBeGreaterThanOrEqual(0.6);
  });

  it('prefers a fresher story when coverage is equal', () => {
    const [first] = rankClusters(clusterItems([item('Alpha beta gamma story', 'A', 60), item('Delta epsilon zeta story', 'B', 1)]), NOW);
    expect(first.items[0].title).toBe('Delta epsilon zeta story');
  });
});

// ---- articles -----------------------------------------------------------------------------------

describe('articles', () => {
  it('extracts the article paragraphs and ignores nav, footer and short strips', () => {
    const text = extractArticleText(ARTICLE_HTML());
    expect(text).toContain('placed their top pass rusher on injured reserve');
    expect(text).not.toContain('newsletter');
    expect(text).not.toContain('Copyright');
  });

  it('prefers JSON-LD articleBody when the page has one', () => {
    const body = 'This is the full body of the article. '.repeat(30);
    const html = `<script type="application/ld+json">{"@type":"NewsArticle","articleBody":"${body}"}</script><p>short</p>`;
    expect(extractArticleText(html)).toContain('full body of the article');
  });

  it('judges whether a page may be framed', () => {
    expect(isEmbeddable(new Headers())).toBe(true);
    expect(isEmbeddable(new Headers({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(false);
    expect(isEmbeddable(new Headers({ 'x-frame-options': 'DENY' }))).toBe(false);
    expect(isEmbeddable(new Headers({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }))).toBe(false);
    expect(isEmbeddable(new Headers({ 'content-security-policy': 'frame-ancestors *' }))).toBe(true);
  });

  it('decodes an old-style Google News id that embeds the article URL, and refuses one that does not', () => {
    const embedded = btoa(`\u0008\u0013"3https://www.freep.com/story/sports/nfl/lions/2026/10/15/ir/123/\u0001`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeEmbeddedGoogleUrl(embedded)).toBe('https://www.freep.com/story/sports/nfl/lions/2026/10/15/ir/123/');
    expect(decodeEmbeddedGoogleUrl('AU_yqLabcdefghijklmnop')).toBeNull();
  });
});

// ---- the AI guardrails --------------------------------------------------------------------------

describe('summary guardrails', () => {
  const articleText = extractArticleText(ARTICLE_HTML());

  it('accepts a good summary built from the text', () => {
    expect(validateSummary(GOOD_SUMMARY, [articleText])).toEqual([]);
  });

  it('rejects a wrong number of sentences', () => {
    expect(validateSummary({ ...GOOD_SUMMARY, summary: 'One. Two. Three. Four. Five. Six. Seven.' }, [articleText])[0]).toMatch(/7 sentences/);
    expect(sentenceCount('Dr. Smith said so. Yes. Right. Maybe.')).toBe(4);
  });

  it('rejects a number the articles never mention (invented facts)', () => {
    const invented = { ...GOOD_SUMMARY, summary: GOOD_SUMMARY.summary.replace('18 sacks', '27 sacks') };
    expect(unsupportedNumbers(invented.summary, [articleText])).toEqual(['27']);
    expect(validateSummary(invented, [articleText]).join(' ')).toMatch(/27/);
  });

  it('rejects long copied runs from an article', () => {
    const copied = { ...GOOD_SUMMARY, summary: `${PARAGRAPHS.match(/placed their top pass rusher on injured reserve on Wednesday after he left Sunday's game/)![0]} and more. Two. Three. Four.` };
    expect(longestSharedRun(copied.summary, [articleText])).toBeGreaterThanOrEqual(10);
    expect(validateSummary(copied, [articleText]).join(' ')).toMatch(/words in a row/);
  });
});

// ---- the free-model AI client -------------------------------------------------------------------

describe('AI client', () => {
  const CFG = { baseUrl: 'https://ai.test/v1', apiKey: 'test-key-123', models: ['model-a', 'model-b'], paceMs: 3_500, maxRetries: 2, timeoutMs: 5_000, callBudget: 50 };
  const okReply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  const status = (code: number, headers: Record<string, string> = {}) => new Response('', { status: code, headers });

  function harness(responder: (model: string, call: number) => Response | Promise<Response>, config = CFG, models = CFG.models) {
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const requests: { url: string; model: string; authorization: string | null }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requests.push({ url, model: body.model, authorization: new Headers(init?.headers).get('authorization') });
      const outcome = await responder(body.model, requests.length);
      return outcome;
    });
    const ai = createAiClient(config, models, {
      fetcher: fetcher as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      now: () => clock,
    });
    return { ai, sleeps, requests, advance: (ms: number) => { clock += ms; } };
  }

  const ask = [{ role: 'user', content: 'hi' }] as ChatMessage[];

  it('posts to the configured endpoint with the key only in the Authorization header', async () => {
    const { ai, requests } = harness(() => okReply('hello'));
    expect(await ai.chat(ask)).toEqual({ content: 'hello', model: 'model-a' });
    expect(requests[0]).toEqual({ url: 'https://ai.test/v1/chat/completions', model: 'model-a', authorization: 'Bearer test-key-123' });
    expect(ai.stats()).toMatchObject({ calls: 1, modelsUsed: { 'model-a': 1 } });
  });

  it('spaces requests at least paceMs apart, even when asked at the same time', async () => {
    const { ai, sleeps } = harness(() => okReply('x'));
    await Promise.all([ai.chat(ask), ai.chat(ask), ai.chat(ask)]);
    expect(sleeps).toEqual([3_500, 3_500]);
  });

  it('waits out a 429 (honouring Retry-After) when it is the only model, and tries it again', async () => {
    const { ai, sleeps, requests } = harness((_, call) => (call === 1 ? status(429, { 'retry-after': '2' }) : okReply('after the wait')), CFG, ['model-a']);
    expect((await ai.chat(ask)).content).toBe('after the wait');
    expect(sleeps).toContain(2_000);
    expect(requests.map((request) => request.model)).toEqual(['model-a', 'model-a']);
    expect(ai.stats().retries).toBe(1);
  });

  it('goes straight to the next model after a 429 instead of waiting (FV2-47)', async () => {
    const { ai, sleeps, requests } = harness((model) => (model === 'model-a' ? status(429, { 'retry-after': '30' }) : okReply('from b')));
    expect((await ai.chat(ask)).model).toBe('model-b');
    // Only the pacing between the two requests: it did not sit out model-a's 30 s.
    expect(sleeps).toEqual([3_500]);
    expect(requests.map((request) => request.model)).toEqual(['model-a', 'model-b']);
  });

  it('uses the models in rotation while they all work, so each one’s own limit is spared (FV2-47)', async () => {
    const { ai, requests } = harness(() => okReply('x'), CFG, ['model-a', 'model-b', 'model-c']);
    for (let i = 0; i < 6; i += 1) await ai.chat(ask);
    expect(requests.map((request) => request.model)).toEqual(['model-a', 'model-b', 'model-c', 'model-a', 'model-b', 'model-c']);
  });

  it('when every model is resting, waits for the first to come back instead of giving up (FV2-47)', async () => {
    const { ai, sleeps, requests } = harness((_, call) => (call <= 2 ? status(429, { 'retry-after': '8' }) : okReply('back')));
    expect((await ai.chat(ask)).content).toBe('back');
    expect(requests).toHaveLength(3);
    // After the second 429 both models rest; the wait is what is left of the first one's 8 s.
    expect(sleeps.some((ms) => ms > 3_500 && ms <= 8_000)).toBe(true);
  });

  it('gives up at once when the models would rest longer than a call will wait (the run then retries those teams)', async () => {
    const { ai, sleeps } = harness(() => status(404));
    await expect(ai.chat(ask)).rejects.toBeInstanceOf(AiUnavailableError);
    // Both are gone for ten minutes: no 10-minute sleep, just the pacing between the two requests.
    expect(sleeps.every((ms) => ms <= 3_500)).toBe(true);
  });

  it('rests a failing model longer each time in a row, and forgets the failures once it works', async () => {
    let clock = 0;
    const waits: number[] = [];
    const responses = [status(503), status(503), okReply('ok')];
    const fetcher = vi.fn(async () => responses.shift() as Response);
    const ai = createAiClient({ ...CFG, models: ['model-a'], maxRetries: 5, maxWaitMs: 300_000 }, ['model-a'], {
      fetcher: fetcher as unknown as typeof fetch,
      sleep: async (ms) => { waits.push(ms); clock += ms; },
      now: () => clock,
    });
    await ai.chat(ask);
    // First rest 10 s, second 20 s (the pacing sleeps are 3.5 s or less).
    expect(waits.filter((ms) => ms > 3_500).map((ms) => Math.round(ms / 100) * 100)).toEqual([10_000, 20_000]);
    // Worked: back to a clean slate.
    responses.push(status(503), okReply('ok again'));
    await ai.chat(ask);
    expect(waits.filter((ms) => ms > 3_500).pop()).toBeLessThanOrEqual(10_000);
  });

  it('does not wait for a resting model past the run’s time budget', async () => {
    let clock = 1_000_000;
    const fetcher = vi.fn(async () => status(429, { 'retry-after': '60' }));
    const ai = createAiClient({ ...CFG, models: ['model-a'], deadlineAt: 1_000_000 + 30_000 }, ['model-a'], {
      fetcher: fetcher as unknown as typeof fetch,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    await expect(ai.chat(ask)).rejects.toBeInstanceOf(AiBudgetError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('moves to the next model when one is gone (404), and leaves the dead one alone for ten minutes', async () => {
    const { ai, requests, advance } = harness((model) => (model === 'model-a' ? status(404) : okReply('from b')));
    expect((await ai.chat(ask)).model).toBe('model-b');
    await ai.chat(ask);
    expect(requests.map((request) => request.model)).toEqual(['model-a', 'model-b', 'model-b']);
    expect(ai.stats().deadModels).toEqual(['model-a']);
    advance(DEAD_MODEL_MS + 1);
    await ai.chat(ask);
    expect(requests[3].model).toBe('model-a');
  });

  it('tries the next model after a forbidden response without treating it as a rejected key', async () => {
    const { ai, requests } = harness((model) => (model === 'model-a' ? status(403) : okReply('from b')));
    expect(await ai.chat(ask)).toEqual({ content: 'from b', model: 'model-b' });
    expect(requests.map((request) => request.model)).toEqual(['model-a', 'model-b']);
    expect(ai.stats().deadModels).toEqual(['model-a']);
  });

  it('treats a model that keeps failing (500s, dropped connections) as dead and uses the next', async () => {
    const { ai, requests } = harness((model, call) => {
      if (model === 'model-a') {
        if (call === 1) throw new Error('socket hang up');
        return status(500);
      }
      return okReply('from b');
    });
    expect((await ai.chat(ask)).model).toBe('model-b');
    expect(requests.map((request) => request.model)).toEqual(['model-a', 'model-b']);
    expect(ai.stats().deadModels).toEqual(['model-a']);
  });

  it('throws AiUnavailableError when every model fails, so the caller keeps yesterday’s stories', async () => {
    const { ai, requests } = harness(() => status(503));
    await expect(ai.chat(ask)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(requests).toHaveLength(4);
  });

  it('stops on a rejected key without trying other models, and never repeats the key in the error', async () => {
    const { ai, requests } = harness(() => status(401));
    const error = await ai.chat(ask).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiAuthError);
    expect(String((error as Error).message)).not.toContain('test-key-123');
    expect(requests).toHaveLength(1);
  });

  it('stops at the call budget (every try counts)', async () => {
    const { ai, requests } = harness(() => okReply('x'), { ...CFG, callBudget: 2 });
    await ai.chat(ask);
    await ai.chat(ask);
    await expect(ai.chat(ask)).rejects.toBeInstanceOf(AiBudgetError);
    expect(requests).toHaveLength(2);
  });

  it('drops a reasoning model’s <think> block and ignores an empty reply', async () => {
    expect(cleanReply('<think>hmm\nmore</think>\n{"a":1}')).toBe('{"a":1}');
    const { ai } = harness((_, call) => (call === 1 ? okReply('<think>only thinking</think>') : okReply('real answer')));
    expect((await ai.chat(ask)).content).toBe('real answer');
  });

  it('keeps only the configured models the endpoint still lists (OpenRouter’s own free router always stays)', async () => {
    const listed = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'other' }] }), { status: 200 }));
    const config = { ...CFG, models: ['model-a', 'model-b', 'openrouter/free'] };
    expect(await resolveModels(config, listed as unknown as typeof fetch)).toEqual(['model-b', 'openrouter/free']);
    // No usable list: the configured models as they are.
    expect(await resolveModels(config, (async () => new Response('', { status: 500 })) as unknown as typeof fetch)).toEqual(config.models);
    expect(await resolveModels(config, (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual(config.models);
  });
});

// ---- the Cloudflare KV client -------------------------------------------------------------------

describe('KV client', () => {
  const SETTINGS = { accountId: 'acct1', apiToken: 'cf-token-xyz', namespaceId: 'ns1' };
  const ok = () => new Response('{"success":true}', { status: 200 });

  function harness(responder: (url: string, init: RequestInit, call: number) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const sleeps: number[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return responder(url, init, calls.length);
    });
    return { kv: createKv(SETTINGS, { fetcher: fetcher as unknown as typeof fetch, sleep: async (ms) => { sleeps.push(ms); } }), calls, sleeps };
  }

  it('writes team:<id> with a time-to-live through the bulk route, token only in the header', async () => {
    const { kv, calls } = harness(() => ok());
    await kv.put(teamKey('nfl-lions'), '{"a":1}', TEAM_TTL_S);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1/storage/kv/namespaces/ns1/bulk');
    expect(calls[0].init.method).toBe('PUT');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer cf-token-xyz');
    expect(JSON.parse(String(calls[0].init.body))).toEqual([{ key: 'team:nfl-lions', value: '{"a":1}', expiration_ttl: TEAM_TTL_S }]);
    expect(calls[0].url).not.toContain('cf-token-xyz');
  });

  it('falls back to the single-key route if the bulk route is refused', async () => {
    const { kv, calls } = harness((url) => (url.endsWith('/bulk') ? new Response('', { status: 405 }) : ok()));
    await kv.put('team:nfl-lions', '{"a":1}', 100);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1/storage/kv/namespaces/ns1/values/team%3Anfl-lions?expiration_ttl=100');
    expect(calls[1].init.body).toBeInstanceOf(FormData);
    expect((calls[1].init.body as FormData).get('value')).toBe('{"a":1}');
  });

  it('retries a 429 with a pause, then gives up with an error that names the status', async () => {
    const retry = harness((_, __, call) => (call === 1 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : ok()));
    await retry.kv.put('k', 'v', 10);
    expect(retry.sleeps).toEqual([3_000]);
    const stuck = harness(() => new Response('', { status: 429 }));
    await expect(stuck.kv.put('k', 'v', 10)).rejects.toMatchObject({ name: 'Error', status: 429 });
    expect(stuck.calls).toHaveLength(4);
  });

  it('does not try the second route on a rejected token', async () => {
    const { kv, calls } = harness(() => new Response('', { status: 403 }));
    await expect(kv.put('k', 'v', 10)).rejects.toBeInstanceOf(KvError);
    expect(calls).toHaveLength(1);
  });

  it('reads a value, and a missing key as null', async () => {
    const { kv, calls } = harness((url) => (url.endsWith('missing') ? new Response('', { status: 404 }) : new Response('stored text', { status: 200 })));
    expect(await kv.get('team:nfl-lions')).toBe('stored text');
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1/storage/kv/namespaces/ns1/values/team%3Anfl-lions');
    expect(await kv.get('missing')).toBeNull();
  });
});

// ---- settings -----------------------------------------------------------------------------------

describe('settings', () => {
  const secrets = { OPENROUTER_API_KEY: 'k', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };

  it('defaults to OpenRouter’s free models, one namespace, 4 stories, and an hourly call budget under the free daily limit', () => {
    const daily = loadConfig(secrets);
    expect(daily).toMatchObject({ mode: 'daily', storiesPerTeam: 4, dryRun: false, teamIds: null });
    expect(daily.ai.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(daily.ai.models).toEqual([...DEFAULT_FREE_MODELS]);
    expect(DEFAULT_FREE_MODELS.every((model) => model.endsWith(':free') || model === 'openrouter/free')).toBe(true);
    expect(daily.ai.paceMs).toBeGreaterThanOrEqual(3_000);
    expect(daily.kv.namespaceId).toBe(DEFAULT_KV_NAMESPACE_ID);
    const afterGame = loadConfig({ ...secrets, PRESS_BOX_MODE: 'after-game' });
    expect(afterGame.mode).toBe('after-game');
    expect(daily.ai.callBudget * 24).toBeLessThanOrEqual(1_000);
    expect(afterGame.ai.callBudget).toBe(daily.ai.callBudget);
  });

  it('takes any OpenAI-compatible endpoint, key and model list from settings', () => {
    const config = loadConfig({ AI_BASE_URL: 'https://api.other.test/v1/', AI_API_KEY: 'other-key', AI_MODELS: 'x/one, y/two', ...secrets, STORIES_PER_TEAM: '9', PRESS_BOX_TEAMS: 'nfl-lions, nba-pistons', DRY_RUN: 'true' });
    expect(config.ai).toMatchObject({ baseUrl: 'https://api.other.test/v1', apiKey: 'other-key', models: ['x/one', 'y/two'] });
    expect(config.storiesPerTeam).toBe(5);
    expect(config.teamIds).toEqual(['nfl-lions', 'nba-pistons']);
    expect(config.dryRun).toBe(true);
  });

  it('names every missing secret, and a dry run needs only the AI key', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/OPENROUTER_API_KEY.*CLOUDFLARE_ACCOUNT_ID.*CLOUDFLARE_API_TOKEN/);
    expect(loadConfig({ OPENROUTER_API_KEY: 'k', DRY_RUN: '1' }).dryRun).toBe(true);
    expect(() => loadConfig({ ...secrets, TEAM_SITE_FEEDS: '{nope' })).toThrow(/TEAM_SITE_FEEDS/);
  });
});

// ---- after-game ---------------------------------------------------------------------------------

describe('after-game', () => {
  const scoreboard = (events: { completed: boolean; abbreviations: string[] }[]) =>
    JSON.stringify({
      events: events.map((event) => ({
        status: { type: { completed: event.completed } },
        competitions: [{ status: { type: { completed: event.completed } }, competitors: event.abbreviations.map((abbreviation) => ({ team: { abbreviation } })) }],
      })),
    });

  it('reads the Eastern calendar day, including late evening and early morning UTC', () => {
    expect(easternDay(Date.parse('2026-10-15T14:00:00Z'))).toBe('20261015');
    expect(easternDay(Date.parse('2026-10-16T03:15:00Z'))).toBe('20261015');
    expect(easternDay(Date.parse('2026-10-15T03:00:00Z'))).toBe('20261014');
  });

  it('builds scoreboard URLs, asking college leagues for the whole division', () => {
    expect(scoreboardUrl('NFL', '20261015')).toBe('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261015&limit=400');
    expect(scoreboardUrl('NCAAF', '20261015')).toContain('groups=80');
    expect(scoreboardUrl('NCAAMB', '20261015')).toContain('groups=50');
    expect(scoreboardUrl('F1', '20261015')).toBeNull();
  });

  it('keeps only the teams in completed games', () => {
    const json = scoreboard([{ completed: true, abbreviations: ['det', 'CHI'] }, { completed: false, abbreviations: ['GB', 'MIN'] }]);
    expect([...completedAbbreviations(json)].sort()).toEqual(['CHI', 'DET']);
    expect(completedAbbreviations('not json').size).toBe(0);
  });

  it('finds the covered teams whose game went final, per league, and survives a scoreboard being down', async () => {
    const issues: string[] = [];
    const teams = ['nfl-lions', 'nfl-packers', 'nba-pistons', 'nhl-redwings'].map((id) => TEAMS.find((team) => team.id === id)!);
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('football/nfl')) return new Response(scoreboard([{ completed: true, abbreviations: ['DET', 'CHI'] }, { completed: false, abbreviations: ['GB', 'MIN'] }]), { status: 200 });
      if (url.includes('hockey/nhl')) return new Response('', { status: 500 });
      return new Response(scoreboard([]), { status: 200 });
    });
    const finished = await finishedTeamIds(teams, fetcher as unknown as typeof fetch, NOW, (message) => issues.push(message));
    // DET also appears in NBA/NHL abbreviations, but only the NFL scoreboard has a completed game.
    expect([...finished]).toEqual(['nfl-lions']);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/NHL/);
  });
});

// ---- one team's stories -------------------------------------------------------------------------

function makeWorld(options: { unreadable?: boolean; failFeeds?: boolean } = {}) {
  const fetcher = vi.fn(async (input: string) => {
    const url = String(input);
    if (options.failFeeds && /rss|site\.web\.api\.espn/.test(url)) return new Response('', { status: 500 });
    if (url.includes('scoreboard')) return new Response(JSON.stringify({ events: [] }), { status: 200 });
    if (url.includes('news.google.com/rss/search')) return new Response(GOOGLE_RSS.replace(/https:\/\/news\.google\.com\/rss\/articles\/[A-Za-z0-9?=]+/g, (_m, offset: number) => `https://${offset % 2 === 0 ? 'www.espn.com' : 'www.cbssports.com'}/story/${offset}`), { status: 200 });
    if (url.includes('site.web.api.espn.com')) return new Response(ESPN_TEAM_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('espn.com/espn/rss')) return new Response(ESPN_RSS, { status: 200 });
    if (options.unreadable) return new Response('<html><body><p>Paywall.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(ARTICLE_HTML(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  return fetcher as unknown as typeof fetch;
}

const storyCount = (messages: ChatMessage[]) => (messages[1].content.match(/--- Story \d+, article 1 /g) ?? []).length;
const goodReply = (count: number) => JSON.stringify({ stories: Array.from({ length: count }, (_, i) => ({ n: i + 1, ...GOOD_SUMMARY })) });

/** A fake AI: `handler` gets the messages and the 1-based call number, and returns the reply text (or throws). */
function fakeAi(handler: (messages: ChatMessage[], call: number) => string = (messages) => goodReply(storyCount(messages))) {
  const calls: ChatMessage[][] = [];
  const ai: AiClient = {
    chat: async (messages) => {
      calls.push(messages);
      return { content: handler(messages, calls.length), model: 'fake/model:free' };
    },
    stats: () => ({ calls: calls.length, retries: 0, modelsUsed: { 'fake/model:free': calls.length }, deadModels: [] }),
  };
  return { ai, calls };
}

async function rankedLions(fetcher: typeof fetch) {
  const { items } = await collectItems(LIONS, undefined, fetcher, NOW, TRUST);
  return rankClusters(clusterItems(items), NOW);
}

describe('one team’s stories', () => {
  it('reads a reply that is fenced, wrapped in a sentence, out of order or half missing', () => {
    const entry = (n: number) => ({ n, headline: `H${n}.`, summary: `S${n}` });
    expect(parseStoriesReply('```json\n' + JSON.stringify({ stories: [entry(1), entry(2)] }) + '\n```', 2)).toEqual([
      { headline: 'H1', summary: 'S1' },
      { headline: 'H2', summary: 'S2' },
    ]);
    expect(parseStoriesReply(`Here you go: ${JSON.stringify({ stories: [entry(2), entry(1)] })} Enjoy!`, 2)[0]).toEqual({ headline: 'H1', summary: 'S1' });
    expect(parseStoriesReply(JSON.stringify({ stories: [entry(1)] }), 3)).toEqual([{ headline: 'H1', summary: 'S1' }, null, null]);
    expect(parseStoriesReply('sorry, no', 2)).toEqual([null, null]);
    expect(parseStoriesReply('{"stories": "nope"}', 2)).toEqual([null, null]);
    expect(parseStoriesReply(JSON.stringify({ stories: [{ n: 1, headline: 5, summary: 'x' }] }), 1)).toEqual([null]);
  });

  it('tells the model to use only the article text, never copy, hedge disagreements, and answer in JSON', async () => {
    const ranked = await rankedLions(makeWorld());
    const { ai, calls } = fakeAi();
    await buildTeamStories(LIONS, ranked, 3, { fetcher: makeWorld(), ai, trust: TRUST, now: NOW });
    const [system, user] = calls[0];
    expect(system.content).toMatch(/ONLY the article text/);
    expect(system.content).toMatch(/never use a long quotation/i);
    expect(system.content).toMatch(/reports/);
    expect(system.content).toMatch(/JSON only/);
    expect(user.content).toContain('placed their top pass rusher');
    expect(buildMessages(LIONS, [], [])[0].content).toContain('Detroit Lions');
  });

  it('rejects an AI summary whose headline is explicitly about another team sport', async () => {
    const fetcher = makeWorld();
    const ranked = await rankedLions(fetcher);
    const { ai, calls } = fakeAi((messages, call) => {
      if (call === 1) return JSON.stringify({ stories: [{ n: 1, headline: 'Detroit Pistons basketball hire a coach', summary: GOOD_SUMMARY.summary }, ...Array.from({ length: storyCount(messages) - 1 }, (_, i) => ({ n: i + 2, ...GOOD_SUMMARY }))] });
      return goodReply(storyCount(messages));
    });
    await buildTeamStories(LIONS, ranked, 3, { fetcher, ai, trust: TRUST, now: NOW });
    expect(calls).toHaveLength(2);
    expect(calls[1][1].content).toMatch(/about another sport/);
    expect(storyCount(calls[1])).toBe(1);
  });

  it('writes up to three stories with ONE AI call, naming the sources', async () => {
    const fetcher = makeWorld();
    const { ai, calls } = fakeAi();
    const build = await buildTeamStories(LIONS, await rankedLions(fetcher), 3, { fetcher, ai, trust: TRUST, now: NOW });
    expect(calls).toHaveLength(1);
    expect(build).toMatchObject({ aiCalls: 1, fallbackStories: 0, aiFailed: false });
    expect(build.stories.length).toBeGreaterThanOrEqual(1);
    expect(build.stories.length).toBeLessThanOrEqual(4);
    expect(build.aiStories).toBe(build.stories.length);
    const story = build.stories[0];
    expect(story).toMatchObject({ headline: GOOD_SUMMARY.headline, summary: GOOD_SUMMARY.summary, embeddable: true });
    expect(story.sources.length).toBeGreaterThan(0);
    expect(story.sources.every((source) => source.name && source.url.startsWith('http'))).toBe(true);
    expect(new Set(build.stories.map((s) => s.id)).size).toBe(build.stories.length);
  });

  it('never writes more stories than asked for', async () => {
    const fetcher = makeWorld();
    const { ai } = fakeAi();
    expect((await buildTeamStories(LIONS, await rankedLions(fetcher), 1, { fetcher, ai, trust: TRUST, now: NOW })).stories).toHaveLength(1);
  });

  it('asks once more, for just the stories that broke the rules, with the objections', async () => {
    const fetcher = makeWorld();
    const bad = { n: 0, headline: 'Lions news', summary: 'Too short.' };
    const { ai, calls } = fakeAi((messages, call) => {
      if (call === 1) return JSON.stringify({ stories: [{ n: 1, ...GOOD_SUMMARY }, ...Array.from({ length: storyCount(messages) - 1 }, (_, i) => ({ ...bad, n: i + 2 }))] });
      return goodReply(storyCount(messages));
    });
    const ranked = await rankedLions(fetcher);
    const build = await buildTeamStories(LIONS, ranked, 3, { fetcher, ai, trust: TRUST, now: NOW });
    if (storyCount(calls[0]) > 1) {
      expect(calls).toHaveLength(2);
      expect(calls[1][1].content).toMatch(/previous answer for story 1 was rejected/);
      expect(storyCount(calls[1])).toBe(storyCount(calls[0]) - 1);
      expect(build.aiCalls).toBe(2);
    }
    expect(build.fallbackStories).toBe(0);
    expect(build.aiStories).toBe(build.stories.length);
  });

  it('falls back to the feed headline and snippet for a story the AI keeps getting wrong', async () => {
    const fetcher = makeWorld();
    const { ai } = fakeAi(() => JSON.stringify({ stories: [{ n: 1, headline: 'Lions news', summary: 'Too short.' }] }));
    const build = await buildTeamStories(LIONS, await rankedLions(fetcher), 3, { fetcher, ai, trust: TRUST, now: NOW });
    expect(build.aiFailed).toBe(false);
    expect(build.stories.length).toBeGreaterThan(0);
    expect(build.fallbackStories).toBe(build.stories.length);
    expect(build.stories.some((story) => story.headline.includes('Lions'))).toBe(true);
  });

  it('writes feed fallbacks, and spends no AI call, when no article can be read', async () => {
    const fetcher = makeWorld({ unreadable: true });
    const { ai, calls } = fakeAi();
    const build = await buildTeamStories(LIONS, await rankedLions(fetcher), 3, { fetcher, ai, trust: TRUST, now: NOW });
    expect(calls).toHaveLength(0);
    expect(build.stories.length).toBeGreaterThan(0);
    expect(build.stories[0].url).toContain('espn.com');
  });

  it('reports aiFailed (so the caller keeps yesterday) when no model answers, and rethrows a rejected key', async () => {
    const fetcher = makeWorld();
    const ranked = await rankedLions(fetcher);
    const down = fakeAi(() => { throw new AiUnavailableError('down'); });
    const failed = await buildTeamStories(LIONS, ranked, 3, { fetcher, ai: down.ai, trust: TRUST, now: NOW });
    expect(failed.aiFailed).toBe(true);
    expect(failed.stories.length).toBeGreaterThan(0);
    const spent = fakeAi(() => { throw new AiBudgetError('spent'); });
    expect((await buildTeamStories(LIONS, ranked, 3, { fetcher, ai: spent.ai, trust: TRUST, now: NOW })).aiFailed).toBe(true);
    const badKey = fakeAi(() => { throw new AiAuthError('refused'); });
    await expect(buildTeamStories(LIONS, ranked, 3, { fetcher, ai: badKey.ai, trust: TRUST, now: NOW })).rejects.toBeInstanceOf(AiAuthError);
  });

  it('builds a graceful fallback story from feed items', () => {
    const item: FeedItem = { title: 'Lions sign veteran', link: 'https://www.espn.com/nfl/story/_/id/9', publishedAt: NOW, source: 'ESPN', description: 'Detroit added a pass rusher.', feed: 'espn' };
    const story = fallbackStoryFromItems('nfl-lions', [item], NOW);
    expect(story.headline).toBe('Lions sign veteran');
    expect(story.summary).toContain('pass rusher');
    expect(story.url).toContain('espn.com');
  });

  it('a feed blurb that only repeats the headline and outlet gives an empty summary, and a real blurb stays (FV2-9)', () => {
    const base: FeedItem = { title: 'Lions fan posts video about Dan Campbell', link: 'https://news.google.com/rss/articles/x', publishedAt: NOW, source: 'Cleveland.com', description: 'Lions fan posts video about Dan Campbell Cleveland.com', feed: 'google' };
    expect(snippetFromItem(base)).toBe('');
    expect(snippetFromItem({ ...base, description: '' })).toBe('');
    expect(snippetFromItem({ ...base, source: 'ESPN', feed: 'espn', description: 'Detroit added a veteran pass rusher on a one-year deal to help a thin defensive line.' })).toContain('pass rusher');
    expect(fallbackStoryFromItems('nfl-lions', [base], NOW).summary).toBe('');
  });
});

// ---- a whole run --------------------------------------------------------------------------------

describe('a run', () => {
  const secrets = { OPENROUTER_API_KEY: 'k', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };
  const config = (extra: Record<string, string> = {}) => loadConfig({ ...secrets, PRESS_BOX_TEAMS: 'nfl-lions', ...extra });

  // FV2-47: the store is one bundle per league (bundle:<league>). `initial` is the teams already stored, by id.
  function memoryKv(initial: Record<string, TeamStories> = {}, legacy: Record<string, TeamStories> = {}) {
    const store = new Map<string, string>();
    const byLeague = new Map<string, Record<string, { updatedAt: string; stories: unknown[] }>>();
    for (const [id, value] of Object.entries(initial)) {
      const league = TEAMS.find((team) => team.id === id)!.league;
      byLeague.set(league, { ...(byLeague.get(league) ?? {}), [id]: { updatedAt: value.updatedAt, stories: value.stories } });
    }
    for (const [league, teams] of byLeague) store.set(bundleKey(league), serializeBundle(league, teams));
    for (const [id, value] of Object.entries(legacy)) store.set(teamKey(id), JSON.stringify(value));
    const puts: { key: string; value: string; ttl?: number }[] = [];
    let reads = 0;
    return {
      store,
      puts,
      reads: () => reads,
      /** One team's stored value out of its league's bundle. */
      team: (id: string): TeamStories | null => {
        const league = TEAMS.find((candidate) => candidate.id === id)!.league;
        const entry = parseBundle(store.get(bundleKey(league)) ?? null)?.teams[id];
        return entry ? { teamId: id, updatedAt: entry.updatedAt, stories: entry.stories as TeamStories['stories'] } : null;
      },
      kv: {
        get: async (key: string) => { reads += 1; return store.get(key) ?? null; },
        put: async (key: string, value: string, ttl?: number) => { store.set(key, value); puts.push({ key, value, ttl }); },
      },
    };
  }
  const logs: string[] = [];
  const deps = (over: { fetcher?: typeof fetch; kv?: ReturnType<typeof memoryKv>['kv'] | null; ai?: AiClient }) => ({
    fetcher: over.fetcher ?? makeWorld(),
    kv: over.kv === undefined ? null : over.kv,
    ai: over.ai ?? fakeAi().ai,
    now: () => NOW,
    log: (line: string) => logs.push(line),
  });
  const yesterday = (hoursBefore: number): TeamStories => ({
    teamId: 'nfl-lions',
    updatedAt: new Date(NOW - hoursBefore * 3_600_000).toISOString(),
    stories: [{ id: 'old', headline: 'Yesterday', summary: 'Yesterday story.', sources: [{ name: 'ESPN', url: 'https://www.espn.com/x' }], url: 'https://www.espn.com/x', embeddable: false, publishedAt: new Date(NOW - 30 * 3_600_000).toISOString() }],
  });
  beforeEach(() => { logs.length = 0; });
  afterEach(() => vi.restoreAllMocks());

  it('writes the team’s stories into its league’s bundle in the shape the app reads, with no expiry', async () => {
    const { kv, team, puts } = memoryKv();
    const { ai, calls } = fakeAi();
    const summary = await runPressBox(config(), deps({ kv, ai }));
    expect(summary).toMatchObject({ teamsInScope: 1, checked: 1, written: 1, skippedNoNews: 0, kvWrites: 1, aiCalls: 1 });
    expect(calls).toHaveLength(1);
    const stored = team('nfl-lions')!;
    expect(stored.teamId).toBe('nfl-lions');
    expect(stored.updatedAt).toBe(new Date(NOW).toISOString());
    expect(stored.stories.length).toBeGreaterThanOrEqual(1);
    expect(stored.stories.length).toBeLessThanOrEqual(4);
    expect(puts.map((put) => put.key)).toEqual(['bundle:nfl']);
    expect(puts[0].ttl).toBeUndefined();
    expect(exitCodeFor(summary)).toBe(0);
  });

  it('checks the news first: nothing newer than the last write means NO AI call and NO write (FV2-47: nothing is re-saved to keep it alive)', async () => {
    const { kv, store, puts } = memoryKv({ 'nfl-lions': yesterday(0) });
    const before = store.get('bundle:nfl');
    const { ai, calls } = fakeAi();
    const summary = await runPressBox(config(), deps({ kv, ai }));
    expect(calls).toHaveLength(0);
    expect(summary).toMatchObject({ checked: 1, skippedNoNews: 1, written: 0, aiCalls: 0 });
    expect(store.get('bundle:nfl')).toBe(before);
    expect(puts).toHaveLength(0);
    expect(summary.kvWrites).toBe(0);
  });

  it('writes again once there is news newer than the last write', async () => {
    const { kv, team } = memoryKv({ 'nfl-lions': yesterday(10) });
    const summary = await runPressBox(config(), deps({ kv }));
    expect(summary.skippedNoNews).toBe(0);
    expect(summary.written).toBe(1);
    expect(team('nfl-lions')!.stories[0].headline).toBe(GOOD_SUMMARY.headline);
  });

  it('keeps yesterday’s stories when no AI model answers', async () => {
    const { kv, store } = memoryKv({ 'nfl-lions': yesterday(10) });
    const before = store.get('bundle:nfl');
    const { ai } = fakeAi(() => { throw new AiUnavailableError('all models failed'); });
    const summary = await runPressBox(config(), deps({ kv, ai }));
    expect(summary).toMatchObject({ keptYesterday: 1, written: 0 });
    expect(store.get('bundle:nfl')).toBe(before);
    expect(summary.failures).toEqual([]);
  });

  it('with nothing stored yet and no AI, writes the feed headlines rather than leaving the team pending', async () => {
    const { kv, team } = memoryKv();
    const { ai } = fakeAi(() => { throw new AiUnavailableError('down'); });
    const summary = await runPressBox(config(), deps({ kv, ai }));
    expect(summary.fallbackWritten).toBe(1);
    expect(team('nfl-lions')!.stories.length).toBeGreaterThan(0);
  });

  it('with nothing stored yet and every feed down, writes an empty list so the team is not stuck pending', async () => {
    const { kv, team } = memoryKv();
    const summary = await runPressBox(config(), deps({ kv, fetcher: makeWorld({ failFeeds: true }) }));
    expect(summary.emptyWritten).toBe(1);
    expect(team('nfl-lions')!.stories).toEqual([]);
  });

  it('dry run does everything except write', async () => {
    const { kv, puts } = memoryKv();
    const summary = await runPressBox(config({ DRY_RUN: '1' }), deps({ kv }));
    expect(summary).toMatchObject({ dryRun: true, written: 1, kvWrites: 0 });
    expect(puts).toHaveLength(0);
  });

  it('after-game mode works only on teams whose game went final today', async () => {
    const base = makeWorld();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('football/nfl/scoreboard')) {
        const event = (completed: boolean, abbreviations: string[]) => ({ status: { type: { completed } }, competitions: [{ status: { type: { completed } }, competitors: abbreviations.map((abbreviation) => ({ team: { abbreviation } })) }] });
        return new Response(JSON.stringify({ events: [event(true, ['DET', 'CHI']), event(false, ['GB', 'MIN'])] }), { status: 200 });
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    const { kv } = memoryKv();
    const summary = await runPressBox(loadConfig({ ...secrets, PRESS_BOX_MODE: 'after-game' }), deps({ kv, fetcher }));
    expect(summary.mode).toBe('after-game');
    expect(summary.teamsInScope).toBe(2);
    expect(summary.checked).toBe(2);
  });

  it('stops at once on a rejected AI key and says so', async () => {
    const { kv, puts } = memoryKv();
    const { ai } = fakeAi(() => { throw new AiAuthError('The AI endpoint refused the key (401).'); });
    const summary = await runPressBox(config({ PRESS_BOX_TEAMS: 'nfl-lions,nfl-packers,nfl-bears', CONCURRENCY: '1' }), deps({ kv, ai }));
    expect(summary.fatal).toMatch(/refused the key/);
    expect(summary.failures).toHaveLength(1);
    expect(puts).toHaveLength(0);
    expect(exitCodeFor(summary)).toBe(1);
  });

  it('logs one JSON line per team and one for the run, with no key or token in them', async () => {
    const { kv } = memoryKv();
    await runPressBox(config(), deps({ kv }));
    const team = JSON.parse(logs.find((line) => line.includes('press-box-team'))!);
    expect(team).toMatchObject({ event: 'press-box-team', team: 'nfl-lions', outcome: 'written', aiCalls: 1 });
    const run = JSON.parse(logs.find((line) => line.includes('press-box-run'))!);
    expect(run).toMatchObject({ event: 'press-box-run', teamsInScope: 1, checked: 1, written: 1, aiCalls: 1, failures: 0 });
    expect(logs.join('\n')).not.toMatch(/"(a|t|k)"|Bearer/);
  });

  it('a covered team count of 290 means a daily run is 290 teams in scope', async () => {
    const { ai } = fakeAi();
    const empty = vi.fn(async () => new Response('<rss></rss>', { status: 200 })) as unknown as typeof fetch;
    const { kv } = memoryKv();
    const summary = await runPressBox(loadConfig({ ...secrets, DRY_RUN: '1' }), deps({ kv, ai, fetcher: empty }));
    expect(summary.teamsInScope).toBe(290);
    expect(summary.checked).toBe(290);
    expect(summary.emptyWritten).toBe(290);
    expect(summary.aiCalls).toBe(0);
  });

  // ---- FV2-47: the store is one bundle per league, so a run costs a handful of KV writes ----------------------------------

  it('a full 290-team run writes one bundle per league: 7 KV writes, not ~290', async () => {
    const empty = vi.fn(async () => new Response('<rss></rss>', { status: 200 })) as unknown as typeof fetch;
    const { kv, puts, store } = memoryKv();
    const summary = await runPressBox(loadConfig({ ...secrets }), deps({ kv, fetcher: empty }));
    expect(summary.teamsInScope).toBe(290);
    expect(summary.emptyWritten).toBe(290);
    expect(summary.kvWrites).toBe(7);
    expect(puts.map((put) => put.key).sort()).toEqual(['bundle:mlb', 'bundle:mls', 'bundle:nba', 'bundle:ncaaf', 'bundle:ncaamb', 'bundle:nfl', 'bundle:nhl']);
    expect(puts.every((put) => put.ttl === undefined)).toBe(true);
    expect(Object.keys(summary.kvBundlesWritten)).toHaveLength(7);
    // Every team is in its league's bundle.
    const stored = Array.from(store.keys()).reduce((sum, key) => sum + Object.keys(parseBundle(store.get(key)!)!.teams).length, 0);
    expect(stored).toBe(290);
  });

  it('a second run with nothing new writes NOTHING: unchanged bundles are not rewritten, skipped teams are not re-saved', async () => {
    const empty = vi.fn(async () => new Response('<rss></rss>', { status: 200 })) as unknown as typeof fetch;
    const { kv, puts } = memoryKv();
    await runPressBox(loadConfig({ ...secrets }), deps({ kv, fetcher: empty }));
    puts.length = 0;
    const second = await runPressBox(loadConfig({ ...secrets }), deps({ kv, fetcher: empty }));
    expect(second.skippedNoNews).toBe(290);
    expect(second.kvWrites).toBe(0);
    expect(puts).toHaveLength(0);
  });

  it('one team with new stories rewrites only its own league’s bundle, and keeps the league’s other teams in it', async () => {
    const other: TeamStories = { ...yesterday(0), teamId: 'nfl-packers' };
    const { kv, puts, team } = memoryKv({ 'nfl-lions': yesterday(10), 'nfl-packers': other });
    const summary = await runPressBox(config(), deps({ kv }));
    expect(summary.written).toBe(1);
    expect(summary.kvWrites).toBe(1);
    expect(puts.map((put) => put.key)).toEqual(['bundle:nfl']);
    expect(team('nfl-lions')!.stories[0].headline).toBe(GOOD_SUMMARY.headline);
    expect(team('nfl-packers')).toEqual(expect.objectContaining({ updatedAt: other.updatedAt }));
  });

  it('seeds a league’s first bundle from the old team:<id> items, even when nothing else changes', async () => {
    const { kv, puts, team } = memoryKv({}, { 'nfl-lions': yesterday(0), 'nfl-packers': { ...yesterday(0), teamId: 'nfl-packers' } });
    const summary = await runPressBox(config(), deps({ kv }));
    expect(summary.skippedNoNews).toBe(1);
    expect(puts.map((put) => put.key)).toEqual(['bundle:nfl']);
    expect(team('nfl-lions')!.stories[0].headline).toBe('Yesterday');
    expect(team('nfl-packers')!.stories[0].headline).toBe('Yesterday');
  });

  it('never writes a per-team item any more', async () => {
    const { kv, puts } = memoryKv({ 'nfl-lions': yesterday(10) });
    await runPressBox(config(), deps({ kv }));
    expect(puts.some((put) => put.key.startsWith('team:'))).toBe(false);
  });

  it('writes a league as soon as its teams are done, and what a stopped run did is still saved', async () => {
    const { kv, puts } = memoryKv();
    const { ai } = fakeAi(() => { throw new AiAuthError('The AI endpoint refused the key (401).'); });
    const summary = await runPressBox(config({ PRESS_BOX_TEAMS: 'nfl-lions,nfl-packers,nfl-bears', CONCURRENCY: '1' }), deps({ kv, ai }));
    expect(summary.fatal).toMatch(/refused the key/);
    expect(summary.kvWrites).toBeLessThanOrEqual(1);
    expect(puts.every((put) => put.key === 'bundle:nfl')).toBe(true);
  });

  it('reports a failed bundle write as a failure, so the run goes red', async () => {
    const { kv } = memoryKv();
    const failing = { get: kv.get, put: async () => { throw new KvError('Cloudflare KV write failed (429)', 429); } };
    const summary = await runPressBox(config(), deps({ kv: failing }));
    expect(summary.failures).toEqual([{ team: 'bundle:nfl', error: 'Cloudflare KV write failed (429)' }]);
    expect(exitCodeFor(summary)).toBe(1);
  });

  it('a full run is far under the free plan’s 1,000 KV writes a day, even with the after-game run and a manual run', async () => {
    const empty = vi.fn(async () => new Response('<rss></rss>', { status: 200 })) as unknown as typeof fetch;
    const { kv, puts } = memoryKv();
    await runPressBox(loadConfig({ ...secrets }), deps({ kv, fetcher: empty }));
    await runPressBox(loadConfig({ ...secrets, PRESS_BOX_MODE: 'after-game' }), deps({ kv, fetcher: empty }));
    await runPressBox(loadConfig({ ...secrets }), deps({ kv, fetcher: empty }));
    expect(puts.length).toBeLessThan(50);
  });

  it('summarises for the Actions page and sets the exit code', () => {
    const base: RunSummary = { mode: 'daily', dryRun: false, teamsInScope: 290, checked: 290, written: 40, skippedNoNews: 250, keptYesterday: 0, fallbackWritten: 0, emptyWritten: 0, failures: [], aiCalls: 41, aiRetries: 1, modelsUsed: { 'a:free': 41 }, kvWrites: 3, kvReads: 7, kvBundlesWritten: { 'bundle:nfl': 90000, 'bundle:nba': 80000, 'bundle:nhl': 70000 }, seconds: 900 };
    const text = formatSummary(base);
    expect(text).toContain('Teams checked | 290');
    expect(text).toContain('Skipped, no new news (no AI call) | 250');
    expect(text).toContain('a:free x41');
    expect(text).toContain('KV writes (free plan: 1,000 a day) | 3 (bundle:nfl, bundle:nba, bundle:nhl)');
    expect(exitCodeFor(base)).toBe(0);
    expect(exitCodeFor({ ...base, failures: [{ team: 'nfl-lions', error: 'boom' }] })).toBe(1);
    expect(formatSummary({ ...base, failures: [{ team: 'nfl-lions', error: 'boom' }] })).toContain('nfl-lions: boom');
    // FV2-47: the free AI being slow is a warning, not a red run: nothing FAILED, yesterday's stories were kept.
    expect(exitCodeFor({ ...base, written: 4, keptYesterday: 36 })).toBe(0);
    expect(exitCodeFor({ ...base, written: 0, keptYesterday: 183 })).toBe(0);
    expect(aiWarning({ ...base, written: 76, keptYesterday: 183 })).toMatch(/183 teams kept yesterday.*76 teams got new stories/);
    expect(formatSummary({ ...base, written: 76, keptYesterday: 183 })).toContain('**Warning:**');
    expect(aiWarning({ ...base, written: 4, keptYesterday: 3 })).toBeNull();
    // A rejected key, or a bundle that could not be written, is red.
    expect(exitCodeFor({ ...base, fatal: 'The AI endpoint refused the key (401).' })).toBe(1);
  });
});

// ---- the workflow and the secrets ---------------------------------------------------------------

describe('workflow', () => {
  const workflow = readFileSync('.github/workflows/press-box.yml', 'utf8');

  it('runs daily and after games, on GitHub’s schedule, with read-only repository access and one run at a time', () => {
    expect(workflow).toMatch(/cron: '7 \* \* \* \*'/);
    expect(workflow).toMatch(/workflow_dispatch/);
    expect(workflow).toMatch(/permissions:\r?\n {2}contents: read/);
    expect(workflow).toMatch(/group: press-box/);
    expect(workflow).toMatch(/npx vite-node src\/main\.ts/);
  });

  it('gets every secret from GitHub Actions secrets, none from code', () => {
    for (const name of ['OPENROUTER_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(workflow).toMatch(/AI_BASE_URL: \$\{\{ vars\.AI_BASE_URL \}\}/);
    expect(workflow).toMatch(/AI_MODELS: \$\{\{ vars\.AI_MODELS \}\}/);
    expect(workflow).not.toMatch(/sk-or-|cfut_|cfat_/);
  });
});

// ---- FV2-47: a full run in under 15 minutes ------------------------------------------------------

describe('a fast run (FV2-47)', () => {
  describe('the AI client', () => {
    const cfg = (extra: Record<string, unknown> = {}) => ({ baseUrl: 'https://ai.test/v1', apiKey: 'test-key-123', models: ['model-a'], paceMs: 3_500, maxRetries: 1, timeoutMs: 5_000, callBudget: 50, ...extra });
    const ask = [{ role: 'user', content: 'hi' }] as ChatMessage[];

    /** A fetcher whose replies are held until `release()`, counting how many are in flight at once. */
    function held(config: ReturnType<typeof cfg>) {
      let clock = 1_000_000;
      let inFlight = 0;
      let mostInFlight = 0;
      const startedAt: number[] = [];
      const bodies: { max_tokens?: number }[] = [];
      const releases: (() => void)[] = [];
      const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as { max_tokens?: number });
        startedAt.push(clock);
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      });
      const ai = createAiClient(config, config.models, { fetcher: fetcher as unknown as typeof fetch, sleep: async (ms) => { clock += ms; }, now: () => clock });
      const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { ai, fetcher, startedAt, bodies, most: () => mostInFlight, advance: (ms: number) => { clock += ms; }, releaseAll: async () => { await settle(); while (releases.length > 0) { releases.shift()!(); await settle(); } }, settle };
    }

    it('runs several requests at once, and still starts them paceMs apart', async () => {
      const h = held(cfg({ concurrency: 3 }));
      const all = Promise.all([1, 2, 3, 4, 5].map(() => h.ai.chat(ask)));
      await h.settle();
      await h.settle();
      expect(h.fetcher).toHaveBeenCalledTimes(3);
      expect(h.most()).toBe(3);
      expect(h.startedAt.map((at, i) => at - h.startedAt[0] - i * 3_500)).toEqual([0, 0, 0]);
      await h.releaseAll();
      await all;
      expect(h.fetcher).toHaveBeenCalledTimes(5);
      expect(h.most()).toBe(3);
    });

    it('is one request at a time unless it is told otherwise', async () => {
      const h = held(cfg());
      const all = Promise.all([1, 2, 3].map(() => h.ai.chat(ask)));
      await h.releaseAll();
      await all;
      expect(h.most()).toBe(1);
    });

    it('lets a request ask for more reply room (a batch of teams needs it)', async () => {
      const h = held(cfg());
      const reply = h.ai.chat(ask, { maxTokens: 6_000 });
      await h.releaseAll();
      await reply;
      expect(h.bodies[0].max_tokens).toBe(6_000);
    });

    it('starts no request once the run’s time budget is spent, and says so the way a spent call budget does', async () => {
      const h = held(cfg({ deadlineAt: 1_000_000 + 10_000 }));
      const first = h.ai.chat(ask);
      await h.releaseAll();
      await first;
      h.advance(20_000);
      await expect(h.ai.chat(ask)).rejects.toBeInstanceOf(AiBudgetError);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('settings', () => {
    const secrets = { OPENROUTER_API_KEY: 'k', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };

    it('defaults to 3 teams per request, 10 requests at once, 12 teams’ feeds at once and a 12-minute budget', () => {
      const config = loadConfig(secrets);
      expect(config).toMatchObject({ batchTeams: 3, concurrency: 12, runBudgetMs: 12 * 60_000 });
      expect(config.ai).toMatchObject({ concurrency: 10, paceMs: 3_500, maxWaitMs: 120_000 });
      expect(config.ai.timeoutMs).toBe(120_000);
    });

    it('rotates across more free models than before, the router last', () => {
      expect(DEFAULT_FREE_MODELS.length).toBeGreaterThanOrEqual(10);
      expect(DEFAULT_FREE_MODELS).toEqual(expect.arrayContaining(['openrouter/free', 'nvidia/nemotron-nano-9b-v2:free']));
      expect(DEFAULT_FREE_MODELS[DEFAULT_FREE_MODELS.length - 1]).toBe('openrouter/free');
      expect(new Set(DEFAULT_FREE_MODELS).size).toBe(DEFAULT_FREE_MODELS.length);
    });

    it('takes them from settings, within sane limits', () => {
      const config = loadConfig({ ...secrets, BATCH_TEAMS: '99', CONCURRENCY: '99', AI_CONCURRENCY: '99', RUN_BUDGET_MINUTES: '5' });
      expect(config).toMatchObject({ batchTeams: 8, concurrency: 24, runBudgetMs: 5 * 60_000 });
      expect(config.ai.concurrency).toBe(16);
    });

    it('the workflow is cut off well under an hour, not after 5 and a half', () => {
      const workflow = readFileSync('.github/workflows/press-box.yml', 'utf8');
      const minutes = Number(/timeout-minutes:\s*(\d+)/.exec(workflow)?.[1]);
      expect(minutes).toBeGreaterThan(15);
      expect(minutes).toBeLessThanOrEqual(30);
    });
  });

  describe('a run', () => {
    const secrets = { OPENROUTER_API_KEY: 'k', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };
    const TEAM_IDS = ['nfl-lions', 'nfl-packers', 'nfl-bears', 'nfl-vikings', 'nfl-cardinals', 'nfl-falcons'];
    const config = (extra: Record<string, string> = {}) => loadConfig({ ...secrets, DRY_RUN: '1', PRESS_BOX_TEAMS: TEAM_IDS.join(','), ...extra });
    const logs: string[] = [];

    /** Every team gets two fresh stories under its own name; articles are the Lions article text. */
    function worldForEveryTeam(onFeed: () => void = () => undefined) {
      const base = makeWorld();
      return vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('news.google.com/rss/search')) {
          onFeed();
          const name = decodeURIComponent(new URL(url).searchParams.get('q') ?? '').replace(/"/g, '').split(' when:')[0].trim();
          const slug = name.toLowerCase().replace(/[^a-z]+/g, '-');
          const items = [1, 2].map((i) => `<item><title>${name} place star pass rusher on injured reserve ${i} - Outlet ${i}</title><link>https://${i === 1 ? 'www.espn.com' : 'www.cbssports.com'}/${slug}/${i}</link><pubDate>${hoursAgo(2)}</pubDate><description>x</description><source url="https://example.com/${i}">Outlet ${i}</source></item>`).join('');
          return new Response(`<?xml version="1.0"?><rss><channel>${items}</channel></rss>`, { status: 200 });
        }
        return (base as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
      }) as unknown as typeof fetch;
    }
    const deps = (over: { ai: AiClient; fetcher?: typeof fetch; now?: () => number }) => ({
      fetcher: over.fetcher ?? worldForEveryTeam(),
      kv: null,
      ai: over.ai,
      now: over.now ?? (() => NOW),
      log: (line: string) => logs.push(line),
    });
    beforeEach(() => { logs.length = 0; });

    it('writes several teams with ONE AI request, numbering their stories straight through under a heading per team', async () => {
      const { ai, calls } = fakeAi();
      const summary = await runPressBox(config({ BATCH_TEAMS: '3' }), deps({ ai }));
      expect(calls).toHaveLength(2);
      expect(summary).toMatchObject({ teamsInScope: 6, checked: 6, written: 6, aiBatches: 2, deferred: 0, failures: [] });
      const first = calls[0][1].content;
      expect(first.match(/=== TEAM: /g)).toHaveLength(3);
      const numbers = [...first.matchAll(/--- Story (\d+), article 1 /g)].map((match) => Number(match[1]));
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
      expect(calls[0][0].content).toMatch(/TEAM:/);
    });

    it('one team per request when asked to', async () => {
      const { ai, calls } = fakeAi();
      await runPressBox(config({ BATCH_TEAMS: '1' }), deps({ ai }));
      expect(calls).toHaveLength(6);
    });

    it('checks every story on its own: the one that breaks the rules is asked again, alone, with its objection', async () => {
      const { ai, calls } = fakeAi((messages, call) => {
        const count = storyCount(messages);
        if (call === 1) return JSON.stringify({ stories: Array.from({ length: count }, (_, i) => (i === 1 ? { n: 2, headline: 'Lions news', summary: 'Too short.' } : { n: i + 1, ...GOOD_SUMMARY })) });
        return goodReply(count);
      });
      const summary = await runPressBox(config({ BATCH_TEAMS: '8' }), deps({ ai }));
      expect(calls).toHaveLength(2);
      expect(storyCount(calls[1])).toBe(1);
      expect(calls[1][1].content).toMatch(/previous answer for story 1 was rejected/);
      expect(summary.written).toBe(6);
      const reports = logs.filter((line) => line.includes('press-box-team')).map((line) => JSON.parse(line) as { aiCalls: number; fallbackStories: number });
      expect(reports.every((report) => report.fallbackStories === 0)).toBe(true);
    });

    it('tries the teams of a failed AI request again later in the same run, and they get their stories (FV2-47)', async () => {
      let call = 0;
      const { ai } = fakeAi((messages) => {
        call += 1;
        if (call === 1) throw new AiUnavailableError('Every AI model failed.');
        return goodReply(storyCount(messages));
      });
      const summary = await runPressBox(config({ BATCH_TEAMS: '3', AI_CONCURRENCY: '1' }), deps({ ai }));
      expect(summary).toMatchObject({ written: 6, fallbackWritten: 0, keptYesterday: 0, failures: [] });
      expect(summary.aiBatches).toBe(3);
    });

    it('tries a team a limited number of times, then it keeps what it had (here: the feed headlines), and the run is still green', async () => {
      const { ai, calls } = fakeAi(() => { throw new AiUnavailableError('Every AI model failed.'); });
      const summary = await runPressBox(config({ BATCH_TEAMS: '3', AI_CONCURRENCY: '1' }), deps({ ai }));
      // 2 batches of 3, each tried once and retried RETRY_PASSES times.
      expect(calls).toHaveLength(2 * (1 + RETRY_PASSES));
      expect(summary).toMatchObject({ fallbackWritten: 6, written: 0, failures: [] });
      expect(exitCodeFor(summary)).toBe(0);
    });

    it('does not retry past the time budget', async () => {
      let clock = NOW;
      const { ai, calls } = fakeAi(() => { clock += 20 * 60_000; throw new AiUnavailableError('Every AI model failed.'); });
      const summary = await runPressBox(config({ BATCH_TEAMS: '6', AI_CONCURRENCY: '1' }), deps({ ai, now: () => clock }));
      expect(calls).toHaveLength(1);
      expect(summary.fallbackWritten).toBe(6);
    });

    it('starts writing while feeds are still being read: the AI sees the first batch before the last team is read', async () => {
      const order: string[] = [];
      const base = worldForEveryTeam();
      const slowFeeds = vi.fn(async (input: string, init?: RequestInit) => {
        if (String(input).includes('news.google.com/rss/search')) order.push('feed');
        await new Promise((resolve) => setTimeout(resolve, 1));
        return (base as unknown as (u: string, i?: RequestInit) => Promise<Response>)(String(input), init);
      }) as unknown as typeof fetch;
      const { ai } = fakeAi((messages) => { order.push('ai'); return goodReply(storyCount(messages)); });
      await runPressBox(config({ BATCH_TEAMS: '1', CONCURRENCY: '1', AI_CONCURRENCY: '1' }), deps({ ai, fetcher: slowFeeds }));
      expect(order.indexOf('ai')).toBeLessThan(order.lastIndexOf('feed'));
    });

    it('leaves the teams it has no time for to the next run: nothing is written for them, and the summary says so', async () => {
      let clock = NOW;
      const fetcher = worldForEveryTeam(() => { clock += 5 * 60_000; });
      const { ai } = fakeAi();
      const summary = await runPressBox(config({ CONCURRENCY: '1', RUN_BUDGET_MINUTES: '12' }), deps({ ai, fetcher, now: () => clock }));
      expect(summary.checked).toBe(2);
      expect(summary.deferred).toBe(4);
      expect(formatSummary(summary)).toMatch(/4 teams were left for the next run/);
    });

    it('prints the total minutes, and warns when a run takes over 15', () => {
      const base = { mode: 'daily', dryRun: false, teamsInScope: 290, checked: 290, written: 1, skippedNoNews: 0, keptYesterday: 0, fallbackWritten: 0, emptyWritten: 0, removedOffSport: 0, cleanupCandidates: 0, cleanedTeams: 0, failures: [], aiCalls: 1, aiRetries: 0, modelsUsed: {}, kvWrites: 1, kvReads: 7, kvBundlesWritten: { 'bundle:nfl': 1 }, aiBatches: 1, deferred: 0 } as const;
      expect(formatSummary({ ...base, seconds: 452 })).toMatch(/Total time \| 7 min 32 s/);
      expect(formatSummary({ ...base, seconds: 452 })).not.toMatch(/should stay under/);
      expect(formatSummary({ ...base, seconds: 931 })).toMatch(/took 15 min 31 s.*under 15 minutes/);
    });
  });
});
