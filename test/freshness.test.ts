import { describe, expect, it } from 'vitest';
import { coveredTeams, hourlyTeams } from '../src/run';
import { mentionsTeam } from '../src/feeds';
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
  it('keeps the source publication time on fallback stories', () => {
    const story = fallbackStoryFromItems('x', [{ title: 'Headline', link: 'https://example.com/a', source: 'Example', description: '', feed: 'league', publishedAt: 1000 }], 100000)!;
    expect(story.publishedAt).toBe(new Date(1000).toISOString());
  });
});
