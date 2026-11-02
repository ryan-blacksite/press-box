/**
 * Purpose: pull recent headlines about a team from public feeds (FV2-3; moved out of the Worker into the writer job, FV2-16).
 * Owns: RSS/Atom parsing, the three feed sources (Google News search RSS, ESPN's league news RSS,
 *   optional official team-site feeds), and the "is this about the team" filter.
 * Notes: Parsing is deliberately forgiving — a feed that changes shape yields fewer items, never an
 *   exception — and every feed is fetched independently: one that is down costs that feed only.
 *   ESPN publishes league-wide feeds, so its items are filtered to the team by name.
 *   Google News needs the publisher name stripped from the title ("Headline - Detroit Free Press").
 *   FV2-154 item 6b/6c: an item is kept only if it is English, is not a stats / line-combinations page, and (unless it comes
 *   through a Google News link, whose real address is only known once the article is fetched and is checked again then) its
 *   address is a trusted sports outlet (outlets.ts).
 *   FV2-154 item 6d: Google News is closed to us by robots.txt, so coverage comes from these allowed feeds as well: CBS Sports and
 *   Yahoo Sports by league, MLB.com's news, and Daily Faceoff for the NHL (LEAGUE_FEEDS). They are league-wide, so items are
 *   filtered to the team by name like ESPN's, and memoizeFeeds() fetches each once per run however many teams read it.
 */
import { FEED_FETCH_TIMEOUT_MS, PRESS_BOX_USER_AGENT } from './httpClient';
import type { FeedItem } from './shared/types';
import type { PressBoxTeam } from './shared/teams';
import { isStoryForTeamSport, sportForLeague } from './shared/storySport';
import { isEnglishText, isNonStoryTitle, isNonStoryUrl, type Trust } from './outlets';

export { FEED_FETCH_TIMEOUT_MS, PRESS_BOX_USER_AGENT } from './httpClient';

const DAY_MS = 86_400_000;
/** A league-wide feed item is about the team only if its name is in the headline or the first words of the blurb, not further in a roundup. */
const ITEM_OPENING_CHARS = 200;
/** Older than this is not "recent". */
export const MAX_ITEM_AGE_MS = 4 * DAY_MS;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (ENTITIES[lower] !== undefined) return ENTITIES[lower];
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16) || 0x20);
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10) || 0x20);
    return whole;
  });
}

/**
 * Plain text from feed markup. Google News sends its <description> entity-escaped
 * ("&lt;a href=...&gt;Headline&lt;/a&gt;&amp;nbsp;&lt;font&gt;Outlet&lt;/font&gt;"), so one decode only turns
 * it back into markup: decode, strip, decode and strip again. A bare "<" in prose ("3 < 5") is not a tag.
 */
export function stripTags(html: string): string {
  let text = html;
  for (let pass = 0; pass < 2; pass += 1) text = decodeEntities(text).replace(/<\/?[a-z!][^>]*>/gi, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function unwrapCdata(value: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  return match ? match[1] : value;
}

function tagText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? unwrapCdata(match[1]).trim() : '';
}

function tagAttr(block: string, tag: string, attr: string): string {
  const match = new RegExp(`<${tag}\\s[^>]*${attr}="([^"]*)"`, 'i').exec(block);
  return match ? decodeEntities(match[1]) : '';
}

/** RSS 2.0 <item> and Atom <entry> alike. */
export function parseFeed(xml: string, feed: FeedItem['feed'], defaultSource: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    let title = stripTags(tagText(block, 'title'));
    const link = (tagText(block, 'link') || tagAttr(block, 'link', 'href')).trim();
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const dateText = tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'dc:date');
    const publishedAt = Date.parse(dateText) || 0;
    let source = stripTags(tagText(block, 'source')) || defaultSource;
    if (feed === 'google') {
      // Google appends " - Publisher" to the title; the <source> element names the same outlet.
      const suffix = source ? ` - ${source}` : '';
      if (suffix && title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
      else {
        const split = /^(.*\S)\s+-\s+([^-]{2,60})$/.exec(title);
        if (split) {
          title = split[1];
          if (!source || source === defaultSource) source = split[2].trim();
        }
      }
    }
    const description = stripTags(tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content'));
    items.push({ title, link: decodeEntities(link), publishedAt, source: source || defaultSource, description, feed });
  }
  return items;
}

/** ESPN's public league news feeds (fallback when the team JSON API is empty). */
const ESPN_FEEDS: Record<string, string> = {
  NFL: 'https://www.espn.com/espn/rss/nfl/news',
  NBA: 'https://www.espn.com/espn/rss/nba/news',
  NHL: 'https://www.espn.com/espn/rss/nhl/news',
  MLB: 'https://www.espn.com/espn/rss/mlb/news',
  MLS: 'https://www.espn.com/espn/rss/soccer/news',
  EPL: 'https://www.espn.com/espn/rss/soccer/news',
  NCAAF: 'https://www.espn.com/espn/rss/ncf/news',
  NCAAMB: 'https://www.espn.com/espn/rss/ncb/news',
};

/** site.web.api.espn.com sport path per league — team news filtered by abbreviation. */
export const ESPN_SPORT_PATH: Record<string, string> = {
  NFL: 'football/nfl',
  NBA: 'basketball/nba',
  NHL: 'hockey/nhl',
  MLB: 'baseball/mlb',
  MLS: 'soccer/usa.1',
  EPL: 'soccer/eng.1',
  NCAAF: 'football/college-football',
  NCAAMB: 'basketball/mens-college-basketball',
};

/** FV2-154 item 6d: allowed league-wide feeds beyond ESPN's (each host's robots.txt allows them; checked 2026-10-31, see COMPLIANCE.md). */
export const LEAGUE_FEEDS: Record<string, { name: string; url: string }[]> = {
  NFL: [{ name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nfl/' }, { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/nfl/rss/' }],
  NBA: [{ name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nba/' }, { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/nba/rss/' }],
  NHL: [
    { name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nhl/' },
    { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/nhl/rss/' },
    { name: 'Daily Faceoff', url: 'https://www.dailyfaceoff.com/feed' },
  ],
  MLB: [
    { name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/mlb/' },
    { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/mlb/rss/' },
    { name: 'MLB.com', url: 'https://www.mlb.com/feeds/news/rss.xml' },
  ],
  MLS: [{ name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/soccer/' }, { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/soccer/rss/' }],
  EPL: [{ name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/soccer/' }, { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/soccer/rss/' }],
  NCAAF: [{ name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/college-football/' }, { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/college-football/rss/' }],
  NCAAMB: [{ name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/college-basketball/' }, { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/college-basketball/rss/' }],
};

const LEAGUE_FEED_URLS = new Set([...Object.values(LEAGUE_FEEDS).flat().map((feed) => feed.url), ...Object.values(ESPN_FEEDS)]);

/**
 * A fetcher that reads each league-wide feed once per run, however many of the ~290 teams ask for it (ESPN's league feeds and the
 * LEAGUE_FEEDS above). Everything else passes straight through. Concurrent askers share one request.
 */
export function memoizeFeeds(fetcher: Fetcher): Fetcher {
  const cache = new Map<string, Promise<{ status: number; statusText: string; headers: [string, string][]; body: string }>>();
  return async (url, init) => {
    if (!LEAGUE_FEED_URLS.has(url)) return fetcher(url, init);
    let entry = cache.get(url);
    if (!entry) {
      entry = fetcher(url, init).then(async (res) => ({ status: res.status, statusText: res.statusText, headers: Array.from(res.headers as unknown as Iterable<[string, string]>), body: await res.text() }));
      cache.set(url, entry);
    }
    const saved = await entry;
    return new Response(saved.body, { status: saved.status, statusText: saved.statusText, headers: saved.headers });
  };
}

export function googleNewsUrl(team: PressBoxTeam): string {
  const sport = sportForLeague(team.league);
  const query = sport === 'basketball' && team.league === 'NCAAMB'
    ? `"${team.name}" basketball -women -women's -women’s when:3d`
    : `"${team.name}" ${sport ?? ''} when:3d`.replace(/\s+/g, ' ').trim();
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

export function espnFeedUrl(team: PressBoxTeam): string | null {
  return ESPN_FEEDS[team.league] ?? null;
}

/** ESPN team-scoped headlines (works from Workers; does not depend on Google News). */
export function espnTeamNewsUrl(team: PressBoxTeam): string | null {
  const sportPath = ESPN_SPORT_PATH[team.league];
  if (!sportPath) return null;
  const abbr = team.abbreviation.trim().toLowerCase();
  if (!abbr) return null;
  return `https://site.web.api.espn.com/apis/site/v2/sports/${sportPath}/news?team=${encodeURIComponent(abbr)}`;
}

/** Parse ESPN's JSON team/league news payload into FeedItems. */
export function parseEspnTeamNews(json: string): FeedItem[] {
  try {
    const data = JSON.parse(json) as { articles?: Record<string, unknown>[] };
    const articles = data.articles ?? [];
    const items: FeedItem[] = [];
    for (const article of articles) {
      const title = typeof article.headline === 'string' ? article.headline.trim() : '';
      const links = article.links as { web?: { href?: string } } | undefined;
      const link = links?.web?.href?.trim() ?? '';
      if (!title || !/^https?:\/\//i.test(link)) continue;
      const description = stripTags(typeof article.description === 'string' ? article.description : '');
      const when = article.published ?? article.lastModified ?? article.publishedAt;
      const publishedAt = typeof when === 'string' || typeof when === 'number' ? Date.parse(String(when)) || 0 : 0;
      items.push({ title, link, publishedAt, source: 'ESPN', description, feed: 'espn' });
    }
    return items;
  } catch {
    return [];
  }
}

/** The nickname is the name without its city ("Lions"); some are two words ("Red Sox", "Trail Blazers"). */
export function nickname(team: PressBoxTeam): string {
  const city = team.city.toLowerCase();
  const name = team.name;
  if (name.toLowerCase().startsWith(`${city} `)) return name.slice(city.length + 1);
  const parts = name.split(' ');
  return parts[parts.length - 1];
}

/** Whether a headline/blurb is about the team: its full name, or its nickname as a whole word. */
export function mentionsTeam(text: string, team: PressBoxTeam): boolean {
  const haystack = text.toLowerCase();
  if (haystack.includes(team.name.toLowerCase())) return true;
  const nick = nickname(team).toLowerCase();
  if (nick.length < 4) return false;
  return new RegExp(`(^|[^a-z])${nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(haystack);
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** An official team-site feed from the optional { "<teamId>": "<https url>" } map (config TEAM_SITE_FEEDS). */
export function teamSiteFeed(feeds: Record<string, string> | undefined, team: PressBoxTeam): string | null {
  const url = feeds?.[team.id];
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
}

async function fetchText(fetcher: Fetcher, url: string, timeoutMs = FEED_FETCH_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {
      signal: controller.signal,
      headers: {
        'user-agent': PRESS_BOX_USER_AGENT,
        accept: 'application/rss+xml, application/xml, application/json, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error(`feed ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every recent item about the team from every feed that answers. Failures are reported through
 * `onIssue` and never thrown; an all-feeds-down team just has no items this run (and keeps its
 * previous stories).
 */
export interface CollectItemsResult {
  items: FeedItem[];
  /** Raw item counts per source before team/age filtering (for logs). */
  sourceCounts: Record<string, number>;
}

export async function collectItems(
  team: PressBoxTeam,
  teamSiteFeeds: Record<string, string> | undefined,
  fetcher: Fetcher,
  now: number,
  trust: Trust,
  onIssue: (message: string) => void = () => undefined,
): Promise<CollectItemsResult> {
  type Job = { key: string; feed: FeedItem['feed']; url: string; source: string; kind: 'rss' | 'espn-json' };
  const jobs: Job[] = [{ key: 'google', feed: 'google', url: googleNewsUrl(team), source: 'Google News', kind: 'rss' }];
  const espnTeam = espnTeamNewsUrl(team);
  if (espnTeam) jobs.push({ key: 'espn-team', feed: 'espn', url: espnTeam, source: 'ESPN', kind: 'espn-json' });
  const espnLeague = espnFeedUrl(team);
  if (espnLeague) jobs.push({ key: 'espn-league', feed: 'espn', url: espnLeague, source: 'ESPN', kind: 'rss' });
  for (const feed of LEAGUE_FEEDS[team.league] ?? []) jobs.push({ key: `league-${feed.name}`, feed: 'league', url: feed.url, source: feed.name, kind: 'rss' });
  const site = teamSiteFeed(teamSiteFeeds, team);
  if (site) jobs.push({ key: 'team-site', feed: 'team', url: site, source: team.name, kind: 'rss' });

  const settled = await Promise.allSettled(
    jobs.map(async (job) => {
      const body = await fetchText(fetcher, job.url);
      return job.kind === 'espn-json' ? parseEspnTeamNews(body) : parseFeed(body, job.feed, job.source);
    }),
  );
  const items: FeedItem[] = [];
  const sourceCounts: Record<string, number> = {};
  settled.forEach((result, index) => {
    const job = jobs[index];
    if (result.status === 'rejected') {
      onIssue(`${job.key} feed failed for ${team.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      sourceCounts[job.key] = 0;
      return;
    }
    sourceCounts[job.key] = result.value.length;
    const teamFiltered = job.key === 'espn-team';
    for (const item of result.value) {
      // Every feed but Google (whose own query is the team) must name the team up front: ESPN's team feed also lists other clubs' stories that merely mention it.
      if (item.feed !== 'google' && !mentionsTeam(`${item.title} ${item.description.slice(0, ITEM_OPENING_CHARS)}`, team)) continue;
      if (!isStoryForTeamSport({ headline: item.title, summary: item.description }, team)) continue;
      // FV2-154: not a Japanese office or a stat page, and not an outlet we do not trust. A Google link is judged on the article it forwards to.
      if (!isEnglishText(`${item.title} ${item.source}`) || isNonStoryTitle(item.title) || isNonStoryUrl(item.link)) continue;
      if (item.feed !== 'google' && !trust.outlet(item.link)) continue;
      // Undated items are kept only from Google, whose own query is already limited to 3 days.
      if (item.publishedAt === 0 ? item.feed !== 'google' && !teamFiltered : now - item.publishedAt > MAX_ITEM_AGE_MS || item.publishedAt > now + DAY_MS) continue;
      items.push(item);
    }
  });
  return { items, sourceCounts };
}
