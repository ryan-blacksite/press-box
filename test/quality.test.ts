/**
 * Purpose: FV2-154 item 6 — the writer's quality rules: a summary never talks about the article (6a), only real English sports
 *   outlets are read and credited (6b), and pages that are not stories are skipped (6c).
 * Owns: tests of guard.ts talksAboutTheArticle/validateSummary, outlets.ts, feeds.ts collectItems and stories.ts prepareTeam.
 * Notes: Uses the exact cases Ryan saw on dev: the "article does not specify" filler, a Dallas Stars story credited to
 *   "Daily Faceoff and 北陸地方整備局", and a "Line Combinations" page.
 */
import { describe, expect, it } from 'vitest';
import { TEAMS } from '../src/shared/teams';
import { collectItems, memoizeFeeds } from '../src/feeds';
import { talksAboutTheArticle, validateSummary } from '../src/guard';
import { isEnglishText, isNonStoryTitle, isNonStoryUrl, looksLikeStatsPage, outletForUrl, trustFor } from '../src/outlets';
import { extractArticleText } from '../src/article';
import { buildMessages, fallbackStoryFromItems, prepareTeam, snippetFromItem } from '../src/stories';
import type { Cluster } from '../src/rank';
import type { FeedItem } from '../src/shared/types';

const STARS = TEAMS.find((team) => team.id === 'nhl-stars')!;
const NOW = Date.parse('2026-10-31T12:00:00Z');
const TRUST = trustFor(undefined);

const PROSE = 'Dallas Stars forward Jason Robertson scored twice on Thursday night as the team beat the Colorado Avalanche in overtime at American Airlines Center. '
  + 'Coach Pete DeBoer said the group played one of its best games of the season and praised the penalty kill after it stopped four chances. '
  + 'The win lifts Dallas to the top of the Central Division with a record of 9 wins and 3 losses after twelve games. '
  + 'Goalie Jake Oettinger made 31 saves and was named the first star by the league after the game. '
  + 'The Stars host the Nashville Predators on Saturday night in the second game of a long home stand. ';
const ARTICLE = PROSE.repeat(2);

describe('summaries never talk about the article (6a)', () => {
  it('flags the filler Ryan saw, and the phrases the ticket names', () => {
    expect(talksAboutTheArticle('The article does not specify what the next opponent will be or how the roster will be adjusted.').length).toBeGreaterThan(0);
    for (const phrase of ['The article says Dallas won.', 'This does not specify the return date.', 'The next opponent is not mentioned.', 'There is no information on his return.', 'It is not specified when he returns.']) {
      expect(talksAboutTheArticle(phrase), phrase).not.toEqual([]);
    }
  });

  it('leaves real news alone, including "did not" reporting about a team', () => {
    for (const fact of ['The team did not disclose the terms of the deal.', 'Robertson did not say whether he will play Saturday.', 'The report was released on Monday.', 'The Stars host Nashville on Saturday.', 'Coach DeBoer said the details are being worked out.']) {
      expect(talksAboutTheArticle(fact), fact).toEqual([]);
    }
  });

  it('rejects a summary with such a sentence through validateSummary, and names it for the retry', () => {
    const summary = 'Jason Robertson scored twice as Dallas beat Colorado in overtime. Coach Pete DeBoer praised the penalty kill. The article does not specify what the next opponent will be.';
    const problems = validateSummary({ headline: 'Stars beat Avalanche in overtime', summary }, [ARTICLE]);
    expect(problems.join(' ')).toMatch(/talks about the article/);
  });

  it('accepts a short summary: 2 sentences is enough, nothing makes it pad', () => {
    expect(validateSummary({ headline: 'Stars beat Avalanche in overtime', summary: 'Jason Robertson scored twice as Dallas beat Colorado in overtime. Jake Oettinger made 31 saves.' }, [ARTICLE])).toEqual([]);
  });

  it('tells the model not to write about the article, and no longer asks for a "what is unknown" sentence', () => {
    const [system] = buildMessages(STARS, []);
    expect(system.content).toMatch(/NEVER write about the article/);
    expect(system.content).not.toMatch(/not yet known/);
  });

  it('drops a feed blurb that talks about the article instead of using it as the summary', () => {
    const item: FeedItem = { title: 'Stars win', link: 'https://www.espn.com/a', publishedAt: NOW, source: 'ESPN', description: 'The article does not specify what the next opponent will be for the club.', feed: 'espn' };
    expect(snippetFromItem(item)).toBe('');
  });
});

describe('only real English sports outlets are read and credited (6b)', () => {
  it('knows the outlets by address and credits them by their own name', () => {
    expect(outletForUrl('https://www.dailyfaceoff.com/teams/dallas-stars/news/x')).toBe('Daily Faceoff');
    expect(outletForUrl('https://www.nhl.com/stars/news/x')).toBe('NHL.com');
    expect(outletForUrl('https://sports.yahoo.com/nhl/x')).toBe('Yahoo Sports');
    expect(outletForUrl('https://www.cbssports.com/nhl/news/x')).toBe('CBS Sports');
    expect(outletForUrl('https://apnews.com/article/x')).toBe('The Associated Press');
  });

  it('refuses a government office, a lookalike host and a bad address', () => {
    expect(outletForUrl('https://www.mlit.go.jp/hokuriku/x')).toBeNull();
    expect(outletForUrl('https://espn.com.evil.example/x')).toBeNull();
    expect(outletForUrl('https://notespn.com/x')).toBeNull();
    expect(outletForUrl('not a url')).toBeNull();
  });

  it('judges English: a Japanese name or page fails, an English headline and article pass', () => {
    expect(isEnglishText('北陸地方整備局')).toBe(false);
    expect(isEnglishText('Daily Faceoff and 北陸地方整備局')).toBe(false);
    expect(isEnglishText('Stars sign defenseman to two-year extension')).toBe(true);
    expect(isEnglishText(ARTICLE)).toBe(true);
    expect(isEnglishText('El equipo ganó el partido anoche en tiempo extra y el entrenador dijo que fue una gran noche para los aficionados de la ciudad. '.repeat(3))).toBe(false);
  });

  it('drops a feed item from a non-English source, and a team-feed item whose address is not a trusted outlet', async () => {
    const feed = (items: string) => `<rss><channel>${items}</channel></rss>`;
    const date = new Date(NOW - 3_600_000).toUTCString();
    const item = (title: string, link: string, source: string) => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description>Dallas Stars news</description><source url="https://x.example">${source}</source></item>`;
    const body = feed([
      item('Dallas Stars place forward on injured reserve', 'https://www.dailyfaceoff.com/news/a', 'Daily Faceoff'),
      item('Dallas Stars place forward on injured reserve 北陸地方整備局', 'https://www.mlit.go.jp/news/b', '北陸地方整備局'),
      item('Dallas Stars sign a defenseman to a new deal', 'https://random-blog.example/c', 'Random Blog'),
    ].join(''));
    const fetcher = async (url: string) => new Response(url.includes('news.google.com') ? body : url.includes('espn') ? '<rss></rss>' : '', { status: 200 });
    const { items } = await collectItems(STARS, undefined, fetcher as unknown as typeof fetch, NOW, TRUST);
    // A Google link is judged on the article it forwards to (prepareTeam), so the unknown blog survives this stage; the Japanese office does not.
    expect(items.map((entry) => entry.link)).toEqual(['https://www.dailyfaceoff.com/news/a', 'https://random-blog.example/c']);

    const team = { 'nhl-stars': 'https://www.nhl.com/stars/rss/news' };
    const teamFetcher = async (url: string) => new Response(url === team['nhl-stars'] ? body : '', { status: 200 });
    const fromTeamFeed = await collectItems(STARS, team, teamFetcher as unknown as typeof fetch, NOW, trustFor(team));
    expect(fromTeamFeed.items.map((entry) => entry.link)).toEqual(['https://www.dailyfaceoff.com/news/a']);
  });

  it('trusts the host of a team-site feed the operator configured, and an EXTRA_OUTLETS host', () => {
    const trust = trustFor({ 'nhl-stars': 'https://www.nhl.com/stars/rss/news' }, 'dallasnews.com=The Dallas Morning News');
    expect(trust.outlet('https://www.nhl.com/stars/news/x')).toBe('NHL.com');
    expect(trust.outlet('https://www.dallasnews.com/sports/x')).toBe('The Dallas Morning News');
    expect(trust.outlet('https://unknown.example/x')).toBeNull();
  });

  it('reads only trusted pages and credits the outlet by its own name, not the feed’s text', async () => {
    const page = (text: string) => `<html><body><article>${text.split('. ').filter(Boolean).map((sentence) => `<p>${sentence}.</p>`).join('')}</article></body></html>`;
    const fetcher = async (url: string) => new Response(url.includes('dailyfaceoff.com') ? page(ARTICLE) : page(ARTICLE.replace(/Dallas/g, 'Dallas')), { status: 200, headers: { 'content-type': 'text/html' } });
    const items: FeedItem[] = [
      { title: 'Stars beat Avalanche in overtime', link: 'https://www.dailyfaceoff.com/news/a', publishedAt: NOW, source: 'Daily Faceoff and 北陸地方整備局', description: '', feed: 'team' },
      { title: 'Stars beat Avalanche in overtime again', link: 'https://www.mlit.go.jp/news/b', publishedAt: NOW, source: '北陸地方整備局', description: '', feed: 'team' },
    ];
    const cluster: Cluster = { items, outlets: ['x', 'y'], newestAt: NOW, score: 1 };
    const prepared = await prepareTeam(STARS, [cluster], 1, fetcher as unknown as typeof fetch, TRUST);
    expect(prepared.inputs).toHaveLength(1);
    expect(prepared.inputs[0].articles.map((article) => article.source)).toEqual(['Daily Faceoff']);
  });
});

describe('pages that are not stories are skipped (6c)', () => {
  it('recognises line-combination, depth-chart and stats pages by title', () => {
    for (const title of ['Dallas Stars Line Combinations | Daily Faceoff', 'Dallas Stars Depth Chart', 'Dallas Stars Stats - NHL.com', 'Dallas Stars Schedule', 'NHL Standings']) {
      expect(isNonStoryTitle(title), title).toBe(true);
    }
  });

  it('keeps real headlines, even ones that use those words in a sentence', () => {
    for (const title of ['Stars sign defenseman to two-year extension', 'Robertson stats keep climbing as Stars win again', 'Stars rally to beat Avalanche in overtime']) {
      expect(isNonStoryTitle(title), title).toBe(false);
    }
  });

  it('recognises the pages by address', () => {
    expect(isNonStoryUrl('https://www.dailyfaceoff.com/teams/dallas-stars/line-combinations')).toBe(true);
    expect(isNonStoryUrl('https://www.espn.com/nhl/team/depth/_/name/dal')).toBe(false);
    expect(isNonStoryUrl('https://www.espn.com/nhl/story/_/id/123/stars-beat-avalanche')).toBe(false);
  });

  it('recognises a page of numbers and short cells as a stats page, and prose as not', () => {
    expect(looksLikeStatsPage('Robertson 12 7 9 16 +4 8 Hintz 12 5 8 13 +2 6 Duchene 12 4 9 13 +1 4 Heiskanen 12 2 10 12 +5 10 Johnston 12 6 4 10 +3 2'.repeat(6))).toBe(true);
    expect(looksLikeStatsPage(ARTICLE)).toBe(false);
  });

  it('skips a line-combinations feed item before it can become a story', async () => {
    const date = new Date(NOW - 3_600_000).toUTCString();
    const body = `<rss><channel><item><title>Dallas Stars Line Combinations | Daily Faceoff</title><link>https://www.dailyfaceoff.com/teams/dallas-stars/line-combinations</link><pubDate>${date}</pubDate><description>Dallas Stars</description></item><item><title>Dallas Stars sign a defenseman to a new deal</title><link>https://www.dailyfaceoff.com/news/d</link><pubDate>${date}</pubDate><description>Dallas Stars</description></item></channel></rss>`;
    const fetcher = async (url: string) => new Response(url.includes('news.google.com') ? body : '', { status: 200 });
    const { items } = await collectItems(STARS, undefined, fetcher as unknown as typeof fetch, NOW, TRUST);
    expect(items.map((entry) => entry.title)).toEqual(['Dallas Stars sign a defenseman to a new deal']);
  });
});

describe('more allowed feeds (6d)', () => {
  it('reads CBS and Yahoo for the team’s league, and Daily Faceoff for the NHL, filtered to the team and credited by outlet', async () => {
    const date = new Date(NOW - 3_600_000).toUTCString();
    const rss = (title: string, link: string) => `<rss><channel><item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description>x</description></item><item><title>Boston Bruins win again</title><link>${link}-other</link><pubDate>${date}</pubDate><description>x</description></item></channel></rss>`;
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      if (url.includes('cbssports.com/rss/headlines/nhl')) return new Response(rss('Stars beat Avalanche in overtime', 'https://www.cbssports.com/nhl/news/stars'), { status: 200 });
      if (url.includes('sports.yahoo.com/nhl/rss')) return new Response(rss('Stars lock up a defenseman', 'https://sports.yahoo.com/articles/stars-1.html'), { status: 200 });
      if (url.includes('dailyfaceoff.com/feed')) return new Response(rss('Stars add a forward', 'https://www.dailyfaceoff.com/news/stars-forward'), { status: 200 });
      return new Response('', { status: 200 });
    };
    const { items } = await collectItems(STARS, undefined, fetcher as unknown as typeof fetch, NOW, TRUST);
    expect(items.map((entry) => entry.source).sort()).toEqual(['CBS Sports', 'Daily Faceoff', 'Yahoo Sports']);
    expect(items.every((entry) => /stars/i.test(entry.title))).toBe(true);
    expect(seen.some((url) => url.includes('cbssports.com/rss/headlines/nhl'))).toBe(true);
  });

  it('fetches a league-wide feed once per run, however many teams read it', async () => {
    let calls = 0;
    const fetcher = async () => { calls += 1; return new Response('<rss></rss>', { status: 200 }); };
    const memo = memoizeFeeds(fetcher as unknown as typeof fetch);
    const url = 'https://www.cbssports.com/rss/headlines/nhl/';
    await Promise.all([memo(url), memo(url), memo(url)]);
    await memo(url);
    expect(calls).toBe(1);
    await memo('https://www.nhl.com/stars/news/x');
    await memo('https://www.nhl.com/stars/news/x');
    expect(calls).toBe(3);
  });
});

describe('FV2-154 round two: the cases the first dry run let through', () => {
  it('skips betting guides, predictions, trackers, lists, highlights, polls and uniform roundups', () => {
    for (const title of [
      'Cowboys vs. Cardinals odds, best bets and expert picks for Week 8',
      'NFL Week 8 predictions: who wins every game',
      'Dallas Cowboys betting guide',
      'Rangers free agency tracker',
      'Who has won the World Series MVP?',
      'NFL Week 8 uniforms: every team’s look',
      'NFL power rankings, Week 8',
      'Game Highlights: Rangers at Astros',
      'Fan poll: should Dallas keep its coach?',
      'Spooky Rangers links',
      'How to watch Stars vs. Blue Jackets: TV channel, start time and live stream',
    ]) {
      expect(isNonStoryTitle(title), title).toBe(true);
    }
  });

  it('keeps real news that shares a word with those lists', () => {
    for (const title of ['Stars trade for two draft picks', 'Lions place pass rusher on injured reserve', 'Mavericks hand Rockets first loss of the season', 'Perron set to debut as Lindell nears return']) {
      expect(isNonStoryTitle(title), title).toBe(false);
    }
  });

  it('skips video, gallery and betting pages by address', () => {
    for (const url of ['https://www.espn.com/video/clip/_/id/1', 'https://www.cbssports.com/nfl/news/odds/', 'https://www.mlb.com/video/game-highlights']) expect(isNonStoryUrl(url), url).toBe(true);
    expect(isNonStoryUrl('https://www.espn.com/nhl/story/_/id/123/stars-beat-avalanche')).toBe(false);
  });

  it('a league feed item counts for the team only when the name is in the headline or the first words of the blurb', async () => {
    const rss = (items: string) => `<rss><channel>${items}</channel></rss>`;
    const item = (title: string, description: string, id: string) => `<item><title>${title}</title><link>https://www.cbssports.com/nhl/news/${id}/</link><description>${description}</description><pubDate>${new Date(NOW - 3_600_000).toUTCString()}</pubDate></item>`;
    const filler = 'Scores and notes from around the league on a busy night with many games and plenty to talk about. '.repeat(3);
    const body = rss(item('Penguins edge Flyers in a shootout', `${filler} Dallas Stars were off.`, 'a') + item('Stars rally past Avalanche', 'A big night in Dallas.', 'b'));
    const fetcher = async (url: string) => new Response(url.includes('cbssports.com/rss/headlines/nhl') ? body : '', { status: url.includes('cbssports.com/rss/headlines/nhl') ? 200 : 404 });
    const { items } = await collectItems(STARS, undefined, fetcher as unknown as typeof fetch, NOW, TRUST);
    expect(items.map((entry) => entry.title)).toEqual(['Stars rally past Avalanche']);
  });

  it('reads an article whose first <article> block is a teaser for another story (ESPN, Yahoo)', async () => {
    const real = PROSE.split('. ').filter(Boolean).map((sentence) => `<p>${sentence}.</p>`).join('');
    const html = `<html><body><article><p>Related: Sabres sign a goalie to a one-year contract, the team announced.</p></article><article>${real}</article></body></html>`;
    const fetcher = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    const cluster: Cluster = { items: [{ title: 'Stars beat Avalanche', link: 'https://www.espn.com/nhl/story/_/id/1/stars', publishedAt: NOW, source: 'ESPN', description: '', feed: 'espn' }], outlets: ['ESPN'], newestAt: NOW, score: 1 };
    const prepared = await prepareTeam(STARS, [cluster], 1, fetcher as unknown as typeof fetch, TRUST);
    expect(prepared.inputs).toHaveLength(1);
    expect(prepared.inputs[0].articles[0].text).toContain('Jason Robertson scored twice');
    expect(prepared.inputs[0].articles[0].text).not.toContain('Sabres');
  });

  it('decodes hexadecimal entities in an article (&#x27;)', () => {
    const html = `<article>${'<p>The coach said it&#x27;s a team that &quot;never quits&quot; and the Stars agree with him after another long night on the road.</p>'.repeat(6)}</article>`;
    expect(extractArticleText(html)).toContain(`it's a team that "never quits"`);
  });

  it('drops an article that is not about the team: the team’s name is not in its opening', async () => {
    const other = ARTICLE.replace(/Dallas Stars|Stars|Dallas/g, 'the club');
    const page = `<html><body><article>${other.split('. ').filter(Boolean).map((sentence) => `<p>${sentence}.</p>`).join('')}</article></body></html>`;
    const fetcher = async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
    const cluster: Cluster = { items: [{ title: 'League notes', link: 'https://www.espn.com/nhl/story/_/id/2/notes', publishedAt: NOW, source: 'ESPN', description: '', feed: 'espn' }], outlets: ['ESPN'], newestAt: NOW, score: 1 };
    const prepared = await prepareTeam(STARS, [cluster], 1, fetcher as unknown as typeof fetch, TRUST);
    expect(prepared.inputs).toHaveLength(0);
  });
});

describe('a headline-only story follows the same credit rules (6b)', () => {
  const item = (source: string, link: string, publishedAt = NOW): FeedItem => ({ title: 'Stars win in overtime', link, publishedAt, source, description: 'Dallas beat Colorado 3-2 in overtime on Thursday night.', feed: 'league' });

  it('credits the allowlist’s own name, once per outlet, not the feed’s text', () => {
    const story = fallbackStoryFromItems('nhl-stars', [item('ESPN', 'https://www.espn.com/a'), item('ESPN', 'https://www.espn.com/b'), item('SB Nation', 'https://www.cbssports.com/c')], NOW, TRUST)!;
    expect(story.sources.map((source) => source.name)).toEqual(['ESPN', 'CBS Sports']);
  });

  it('writes no story at all from a source that is not trusted', () => {
    expect(fallbackStoryFromItems('nhl-stars', [item('SB Nation', 'https://www.fanposts.example/a'), item('Hockey News', 'https://www.thehockeynews.com/a')], NOW, TRUST)).toBeNull();
  });

  it('uses only the trusted items when some are not', () => {
    const story = fallbackStoryFromItems('nhl-stars', [item('SB Nation', 'https://www.fanposts.example/a', NOW), item('Daily Faceoff', 'https://www.dailyfaceoff.com/b', NOW - 1_000)], NOW, TRUST)!;
    expect(story.url).toBe('https://www.dailyfaceoff.com/b');
    expect(story.sources.map((source) => source.name)).toEqual(['Daily Faceoff']);
  });
});

describe('FV2-154 round two, second pass', () => {
  it('skips the guides the second dry run let through', () => {
    for (const title of [
      'NHL Tonight: What to watch in all 10 spooky games on Halloween',
      '2027 NFL draft order projections for Round 1, chances for top pick, more',
      '2026 NBA Cup: Schedule, format, groups, updates and more',
      'Columbus Blue Jackets (10pts) vs. Dallas Stars (15 pts) Game Preview',
      'Everything you need to know about the NBA Cup',
    ]) expect(isNonStoryTitle(title), title).toBe(true);
    expect(isNonStoryUrl('http://www.espn.com/nhl/preview?gameId=401892622')).toBe(true);
    expect(isNonStoryUrl('http://www.espn.com/nba/recap?gameId=401909283')).toBe(false);
  });

  it('ESPN’s team feed is held to the same “team named up front” rule as the others', async () => {
    const json = JSON.stringify({ articles: [
      { headline: 'Where the Vikings rank among worst 6-0 teams', description: 'Aaron Schatz ranked the worst 6-0 teams ever by DVOA and point differential.', links: { web: { href: 'https://www.espn.com/nfl/story/_/id/1/vikings' } }, published: new Date(NOW - 3_600_000).toISOString() },
      { headline: 'Stars rally past Avalanche', description: 'A big night in Dallas.', links: { web: { href: 'https://www.espn.com/nhl/story/_/id/2/stars' } }, published: new Date(NOW - 3_600_000).toISOString() },
    ] });
    const fetcher = async (url: string) => (url.includes('site.web.api.espn.com') ? new Response(json, { status: 200 }) : new Response('', { status: 404 }));
    const { items } = await collectItems(STARS, undefined, fetcher as unknown as typeof fetch, NOW, TRUST);
    expect(items.map((entry) => entry.title)).toEqual(['Stars rally past Avalanche']);
  });
});
