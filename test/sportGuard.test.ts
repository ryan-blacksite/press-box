/**
 * Purpose: verify FV2-29 blocks college cross-sport stories and removes those already stored.
 * Owns: before/after samples for five college football and five men's basketball teams, plus the cleanup-only writer path.
 * Notes: This protects the writer and read-only Worker using the same topic guard; no live KV data is changed by this test.
 */
import { describe, expect, it } from 'vitest';
import { googleNewsUrl } from '../src/feeds';
import { loadConfig } from '../src/config';
import { runPressBox } from '../src/run';
import { filterStoriesForTeam } from '../src/shared/storySport';
import { parseTeamStories } from '../src/shared/store';
import { bundleKey, parseBundle, serializeBundle } from '../src/shared/bundle';
import { TEAMS } from '../src/shared/teams';
import type { TeamStories } from '../src/shared/types';

const team = (id: string) => {
  const found = TEAMS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing sample team ${id}`);
  return found;
};

const footballSamples = [
  ['ncaaf-act', 'Alabama', 'Alabama football names its starting quarterback'],
  ['ncaaf-aw', 'Arizona', 'Arizona Wildcats football prepare for Saturday'],
  ['ncaaf-dbd1', 'Duke', 'Duke football earns a key conference win'],
  ['ncaaf-kj', 'Kansas', 'Kansas football adds a quarterback in recruiting'],
  ['ncaaf-mw', 'Michigan', 'Michigan football opens fall camp'],
] as const;

const basketballSamples = [
  ['ncaamb-act', 'Alabama', 'Alabama basketball announces its starting lineup'],
  ['ncaamb-aw', 'Arizona', 'Arizona Wildcats basketball win the opener'],
  ['ncaamb-dbd1', 'Duke', 'Duke basketball prepares for conference play'],
  ['ncaamb-kj', 'Kansas', 'Kansas basketball lands a top recruit'],
  ['ncaamb-mw', 'Michigan', 'Michigan basketball opens Big Ten play'],
] as const;

const story = (headline: string) => ({ id: headline, headline, summary: '', sources: [], url: 'https://example.com', embeddable: false, publishedAt: '2026-10-16T12:00:00.000Z' });

describe('FV2-29 Press Box sport guard', () => {
  it('searches by the team sport and excludes women’s basketball', () => {
    expect(new URL(googleNewsUrl(team('ncaaf-act'))).searchParams.get('q')).toContain('football');
    const basketballQuery = new URL(googleNewsUrl(team('ncaamb-act'))).searchParams.get('q') ?? '';
    expect(basketballQuery).toContain('basketball');
    expect(basketballQuery).toContain('-women');
  });

  it('shows before/after samples for five college football and five men’s basketball teams', () => {
    for (const [id, school, expected] of footballSamples) {
      const before = [story(expected), story(`${school} women's soccer reaches the NCAA final`), story(`${school} softball wins series`)];
      const after = filterStoriesForTeam(before, team(id));
      expect(after.map((entry) => entry.headline)).toEqual([expected]);
    }
    for (const [id, school, expected] of basketballSamples) {
      const before = [story(expected), story(`${school} women's soccer reaches the NCAA final`), story(`${school} football adds a new quarterback`)];
      const after = filterStoriesForTeam(before, team(id));
      expect(after.map((entry) => entry.headline)).toEqual([expected]);
    }
  });

  it('filters off-sport stories from KV reads immediately after the Worker is updated', () => {
    const raw = JSON.stringify({
      teamId: 'ncaaf-act',
      updatedAt: '2026-10-16T12:00:00.000Z',
      stories: [story('Alabama football names its starting quarterback'), story("Alabama women's soccer reaches the NCAA final")],
    });
    expect(parseTeamStories(raw, 'ncaaf-act')?.stories.map((entry) => entry.headline)).toEqual(['Alabama football names its starting quarterback']);
  });

  it('keeps same-city pro teams from receiving stories about each other', () => {
    expect(filterStoriesForTeam([story('Detroit Pistons basketball add a new guard')], team('nfl-lions'))).toEqual([]);
    expect(filterStoriesForTeam([story('Detroit Lions football name a starting quarterback')], team('nba-pistons'))).toEqual([]);
  });

  it('cleans stored records without fetching news or calling AI', async () => {
    const original: TeamStories = {
      teamId: 'ncaaf-act',
      updatedAt: '2026-10-16T12:00:00.000Z',
      stories: [story('Alabama football names its starting quarterback'), story("Alabama women's soccer reaches the NCAA final")],
    };
    // FV2-47: the stored record is the league's bundle; the cleaned bundle is written back once.
    const stored = serializeBundle('NCAAF', { 'ncaaf-act': { updatedAt: original.updatedAt, stories: original.stories } });
    let saved: string | null = null;
    let savedKey = '';
    let fetchCalls = 0;
    let aiCalls = 0;
    const config = loadConfig({ PRESS_BOX_MODE: 'cleanup', PRESS_BOX_TEAMS: 'ncaaf-act', CLOUDFLARE_ACCOUNT_ID: 'test', CLOUDFLARE_API_TOKEN: 'test' });
    const summary = await runPressBox(config, {
      fetcher: async () => { fetchCalls += 1; throw new Error('cleanup must not fetch'); },
      kv: { get: async (key: string) => (key === bundleKey('NCAAF') ? stored : null), put: async (key, value) => { savedKey = key; saved = value; } },
      ai: { chat: async () => { aiCalls += 1; throw new Error('cleanup must not call AI'); }, stats: () => ({ calls: 0, retries: 0, modelsUsed: {}, deadModels: [] }) },
      now: () => Date.parse('2026-10-17T00:00:00.000Z'),
      log: () => undefined,
    });
    expect(fetchCalls).toBe(0);
    expect(aiCalls).toBe(0);
    expect(summary.removedOffSport).toBe(1);
    expect(summary.cleanupCandidates).toBe(1);
    expect(summary.cleanedTeams).toBe(1);
    expect(savedKey).toBe('bundle:ncaaf');
    expect(summary.kvWrites).toBe(1);
    expect((parseBundle(saved)!.teams['ncaaf-act'].stories as { headline: string }[]).map((entry) => entry.headline)).toEqual(['Alabama football names its starting quarterback']);
  });

  it('reports cleanup candidates without writing in dry-run mode', async () => {
    let writes = 0;
    const config = loadConfig({ PRESS_BOX_MODE: 'cleanup', DRY_RUN: '1', PRESS_BOX_TEAMS: 'ncaaf-act', CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' });
    const summary = await runPressBox(config, {
      fetcher: async () => { throw new Error('cleanup must not fetch'); },
      kv: { get: async (key: string) => (key === bundleKey('NCAAF') ? serializeBundle('NCAAF', { 'ncaaf-act': { updatedAt: '2026-10-16T12:00:00.000Z', stories: [story("Alabama women's soccer reaches the NCAA final")] } }) : null), put: async () => { writes += 1; } },
      ai: { chat: async () => { throw new Error('cleanup must not call AI'); }, stats: () => ({ calls: 0, retries: 0, modelsUsed: {}, deadModels: [] }) },
      now: () => Date.parse('2026-10-17T00:00:00.000Z'),
      log: () => undefined,
    });
    expect(summary.cleanupCandidates).toBe(1);
    expect(summary.cleanedTeams).toBe(0);
    expect(writes).toBe(0);
  });

  it('requires KV credentials for a cleanup dry run, but not an AI key', () => {
    expect(() => loadConfig({ PRESS_BOX_MODE: 'cleanup', DRY_RUN: '1' })).toThrow('CLOUDFLARE_ACCOUNT_ID');
    expect(loadConfig({ PRESS_BOX_MODE: 'cleanup', DRY_RUN: '1', CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }).ai.apiKey).toBe('');
  });
});
