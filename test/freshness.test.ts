import { describe, expect, it } from 'vitest';
import { coveredTeams, hourlyTeams } from '../src/run';
import { collectItems, mentionsTeam } from '../src/feeds';
import { trustFor } from '../src/outlets';
import { fallbackStoryFromItems } from '../src/stories';

describe('college and freshness regressions', () => {
  it('visits every team once over four consecutive hourly partitions', () => {
    const teams = coveredTeams();
    const visited = [0, 1, 2, 3].flatMap((hour) => hourlyTeams(teams, hour * 3_600_000));
    expect(visited).toHaveLength(teams.length);
    expect(new Set(visited.map((team) => team.id)).size).toBe(teams.length);
  });
  it('recognizes the school name without confusing State or shared nicknames', () => {
    const indiana = coveredTeams().find((team) => team.id === 'ncaaf-ih')!;
    const iowa = coveredTeams().find((team) => team.id === 'ncaaf-ih1')!;
    expect(mentionsTeam('Indiana football names a quarterback', indiana)).toBe(true);
    expect(mentionsTeam('Indiana State football names a quarterback', indiana)).toBe(false);
    expect(mentionsTeam('Iowa State football names a quarterback', iowa)).toBe(false);
    expect(mentionsTeam('The Tigers win a football game', indiana)).toBe(false);
  });
  it('does not attribute a college roundup from a blurb-only mention', async () => {
    const team = coveredTeams().find((entry) => entry.id === 'ncaaf-ih1')!;
    const xml = `<rss><channel><item><title>College football winners: Oregon rebounds</title><link>https://www.cbssports.com/a</link><pubDate>${new Date().toUTCString()}</pubDate><description>Iowa football also played this week.</description></item></channel></rss>`;
    const fetcher = async (url: string) => new Response(url.includes('cbssports.com') ? xml : '', { status: 200 });
    const result = await collectItems(team, undefined, fetcher, Date.now(), trustFor(undefined, undefined));
    expect(result.items).toEqual([]);
  });
  it('keeps the source publication time on fallback stories', () => {
    const story = fallbackStoryFromItems('x', [{ title: 'Headline', link: 'https://example.com/a', source: 'Example', description: '', feed: 'league', publishedAt: 1000 }], 100000)!;
    expect(story.publishedAt).toBe(new Date(1000).toISOString());
  });
});
