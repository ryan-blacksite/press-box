import { describe, expect, it } from 'vitest';
import { createRobotsFetcher, parseRobots, robotsAllows, RobotsBlockedError } from '../src/robots';

const GOOGLE_LIKE = 'User-agent: *\nDisallow: /\nAllow: /$\nAllow: /topics/\n\nUser-agent: Googlebot\nDisallow: /\n';
const ESPN_LIKE = 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /espn/now\nDisallow: */boxscore?\n';

describe('robots.txt', () => {
  it('blocks what a "*" group disallows and honors the longer Allow rules', () => {
    const rules = parseRobots(GOOGLE_LIKE);
    expect(robotsAllows(rules, '/rss/search?q=lions')).toBe(false);
    expect(robotsAllows(rules, '/topics/abc')).toBe(true);
    expect(robotsAllows(rules, '/')).toBe(true);
  });

  it('ignores other bots’ groups, and wildcards work', () => {
    const rules = parseRobots(ESPN_LIKE);
    expect(robotsAllows(rules, '/espn/rss/nfl/news')).toBe(true);
    expect(robotsAllows(rules, '/espn/now')).toBe(false);
    expect(robotsAllows(rules, '/nfl/boxscore?gameId=1')).toBe(false);
  });

  it('a group naming us beats "*"', () => {
    const rules = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: PressBox\nDisallow: /private\n');
    expect(robotsAllows(rules, '/private/x')).toBe(false);
    expect(robotsAllows(rules, '/public')).toBe(true);
  });

  it('fetches robots.txt once per host, never fetches a disallowed page, treats 404 as open and 503 as closed', async () => {
    const calls: string[] = [];
    const raw = async (url: string) => {
      calls.push(url);
      if (url === 'https://a.test/robots.txt') return new Response('User-agent: *\nDisallow: /secret', { status: 200 });
      if (url === 'https://b.test/robots.txt') return new Response('nope', { status: 404 });
      if (url === 'https://c.test/robots.txt') return new Response('down', { status: 503 });
      return new Response('ok');
    };
    const guarded = createRobotsFetcher(raw, 'ua');
    expect(await (await guarded('https://a.test/news')).text()).toBe('ok');
    await expect(guarded('https://a.test/secret/page')).rejects.toBeInstanceOf(RobotsBlockedError);
    await guarded('https://a.test/more');
    expect(calls.filter((url) => url === 'https://a.test/robots.txt')).toHaveLength(1);
    expect(calls).not.toContain('https://a.test/secret/page');
    await guarded('https://b.test/anything');
    await expect(guarded('https://c.test/anything')).rejects.toBeInstanceOf(RobotsBlockedError);
  });
});
