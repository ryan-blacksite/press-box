/**
 * FFB-365: the Press Box contract. The writer job (this repo) fills the store; the fly-press-box Worker
 * (fly-frontend workers/press-box) serves it as GET /v1/press-box and GET /v1/scouting-report, and the
 * app reads exactly those shapes. This test pins both shapes with a sample response for each, using
 * the writer's own write path (bundles) and read path (store + scouting, mirrored from the Worker).
 *
 * What is writer-owned here: the bundle content (one entry per team, that team's stories only) and
 * the stored story fields. The envelope assembly (status words, per-team keys) mirrors the Worker's
 * index.ts mapping, so a drift there shows up as a failing sample too; the Worker itself is not
 * changed by this repo.
 *
 * The live check behind this test (2026-11-02): the deployed Worker answered both endpoints in
 * exactly these shapes for Lions, Pistons, Cowboys, Packers, Lakers, Tigers, Avalanche and an
 * unknown team, with no story appearing under two teams. The missing pinned report on the fan's
 * device is therefore not the writer's response shape (see FFB-365).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createBundles } from '../src/bundles';
import type { KvStore } from '../src/kv';
import { clearBundleCache, readTeamResult } from '../src/shared/store';
import { buildScoutingReport } from '../src/shared/scouting';
import { TEAMS, type PressBoxTeam } from '../src/shared/teams';
import type { Env, Story, TeamStories } from '../src/shared/types';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const isoHoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const LIONS = TEAMS.find((team) => team.id === 'nfl-lions')!;
const PISTONS = TEAMS.find((team) => team.id === 'nba-pistons')!;
const PACKERS = TEAMS.find((team) => team.id === 'nfl-packers')!;

function story(partial: Partial<Story> & Pick<Story, 'id' | 'headline' | 'url'>): Story {
  return { summary: '', sources: [], embeddable: false, publishedAt: isoHoursAgo(1), ...partial };
}

/** The sample stories: Lions (2) and Pistons (1), each only about its own team. */
const LIONS_STORIES: Story[] = [
  story({
    id: 'nfl-lions-abc123',
    headline: 'Lions rally past Vikings in the fourth quarter',
    summary:
      'The Detroit Lions scored twice in the fourth quarter to beat the Minnesota Vikings. Quarterback Jared Goff threw the go-ahead touchdown pass with two minutes left. The win keeps Detroit alone in first place in its division. The defense sealed it with an interception on the final drive.',
    sources: [
      { name: 'ESPN', url: 'https://www.espn.com/nfl/recap?gameId=1' },
      { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/articles/lions-vikings-1.html' },
    ],
    url: 'https://www.espn.com/nfl/recap?gameId=1',
    publishedAt: isoHoursAgo(2),
  }),
  story({
    id: 'nfl-lions-def456',
    headline: 'Lions place linebacker on injured reserve',
    summary: 'The Detroit Lions placed their top linebacker on injured reserve after a knee injury. The team signed a veteran replacement the same day.',
    sources: [{ name: 'Yahoo Sports', url: 'https://sports.yahoo.com/articles/lions-ir-1.html' }],
    url: 'https://sports.yahoo.com/articles/lions-ir-1.html',
    publishedAt: isoHoursAgo(3),
  }),
];

const PISTONS_STORIES: Story[] = [
  story({
    id: 'nba-pistons-ghi789',
    headline: 'Pistons rout Nets behind Cunningham',
    summary:
      'Cade Cunningham scored 20 points and Duncan Robinson added 17 for the Pistons. The Pistons beat the Brooklyn Nets 110-94 in an NBA Cup opener. Detroit has now won five of its first six games.',
    sources: [
      { name: 'ESPN', url: 'https://www.espn.com/nba/recap?gameId=2' },
      { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/articles/pistons-nets-1.html' },
      { name: 'CBS Sports', url: 'https://www.cbssports.com/nba/news/pistons-nets-1/' },
    ],
    url: 'https://www.espn.com/nba/recap?gameId=2',
    publishedAt: isoHoursAgo(1),
  }),
];

/** Sample response for GET /v1/press-box?teams=nfl-lions,nba-pistons,nfl-packers,nfl-nope. */
const SAMPLE_PRESS_BOX_RESPONSE = {
  teams: {
    'nfl-lions': { status: 'ready', updatedAt: '2026-11-02T11:00:00.000Z', stories: LIONS_STORIES },
    'nba-pistons': { status: 'ready', updatedAt: '2026-11-02T11:00:00.000Z', stories: PISTONS_STORIES },
    'nfl-packers': { status: 'pending', stories: [] },
    'nfl-nope': { status: 'not-covered', stories: [] },
  },
};

/** Sample response for GET /v1/scouting-report?teams=nfl-lions,nba-pistons&slot=morning. */
const SAMPLE_SCOUTING_RESPONSE = {
  status: 'ready',
  report: {
    id: 'morning-1qr8zna',
    slot: 'morning',
    title: 'Morning Scouting Report',
    teaser: 'Pistons rout Nets behind Cunningham',
    items: [
      {
        teamId: 'nba-pistons',
        teamName: 'Detroit Pistons',
        storyId: 'nba-pistons-ghi789',
        headline: 'Pistons rout Nets behind Cunningham',
        text: 'Cade Cunningham scored 20 points and Duncan Robinson added 17 for the Pistons.',
        url: 'https://www.espn.com/nba/recap?gameId=2',
      },
      {
        teamId: 'nfl-lions',
        teamName: 'Detroit Lions',
        storyId: 'nfl-lions-abc123',
        headline: 'Lions rally past Vikings in the fourth quarter',
        text: 'The Detroit Lions scored twice in the fourth quarter to beat the Minnesota Vikings.',
        url: 'https://www.espn.com/nfl/recap?gameId=1',
      },
      {
        teamId: 'nfl-lions',
        teamName: 'Detroit Lions',
        storyId: 'nfl-lions-def456',
        headline: 'Lions place linebacker on injured reserve',
        text: 'The Detroit Lions placed their top linebacker on injured reserve after a knee injury.',
        url: 'https://sports.yahoo.com/articles/lions-ir-1.html',
      },
    ],
    generatedAt: '2026-11-02T12:00:00.000Z',
    teams: ['nba-pistons', 'nfl-lions'],
  },
};

function memoryKv() {
  const store = new Map<string, string>();
  const kv: KvStore = {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
    },
  };
  return { store, kv };
}

function memoryEnv(store: Map<string, string>): Env {
  return {
    PRESS_BOX_KV: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
      list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
    },
    ALLOWED_ORIGIN: '',
  };
}

/** Seed a league's bundle through the writer's own staging path. */
async function seedLeague(kv: KvStore, league: string, members: PressBoxTeam[], values: TeamStories[]) {
  const bundles = createBundles(kv, { dryRun: false });
  await bundles.load(league, members);
  for (const value of values) {
    const team = members.find((candidate) => candidate.id === value.teamId)!;
    bundles.set(team, value);
  }
  await bundles.flush(league);
}

/** The Worker's /v1/press-box mapping (workers/press-box/src/index.ts), over this repo's read path. */
async function pressBoxEnvelope(env: Env, ids: string[], now: number) {
  const teams: Record<string, unknown> = Object.create(null);
  await Promise.all(
    ids.map(async (id) => {
      if (!TEAMS.some((team) => team.id === id)) {
        teams[id] = { status: 'not-covered', stories: [] };
        return;
      }
      const read = await readTeamResult(env, id, now);
      if (read.kind === 'stored') teams[id] = { status: 'ready', updatedAt: read.value.updatedAt, stories: read.value.stories };
      else teams[id] = { status: 'pending', stories: [] };
    }),
  );
  return { teams };
}

beforeEach(() => {
  clearBundleCache();
});

describe('FFB-365 contract: GET /v1/press-box', () => {
  it('answers the sample response: per-team statuses, keys and story fields, each team only its own stories', async () => {
    const { store, kv } = memoryKv();
    const updatedAt = '2026-11-02T11:00:00.000Z';
    await seedLeague(kv, 'NFL', [LIONS, PACKERS], [{ teamId: 'nfl-lions', updatedAt, stories: LIONS_STORIES }]);
    await seedLeague(kv, 'NBA', [PISTONS], [{ teamId: 'nba-pistons', updatedAt, stories: PISTONS_STORIES }]);
    const env = memoryEnv(store);

    const body = await pressBoxEnvelope(env, ['nfl-lions', 'nba-pistons', 'nfl-packers', 'nfl-nope'], NOW);
    expect(body).toEqual(SAMPLE_PRESS_BOX_RESPONSE);

    // A story never appears under two teams, and every story id belongs to its team.
    const seen = new Map<string, string>();
    for (const [teamId, result] of Object.entries(body.teams)) {
      const stories = (result as { stories: Story[] }).stories;
      for (const s of stories) {
        expect(seen.get(s.id)).toBeUndefined();
        seen.set(s.id, teamId);
        expect(s.id.startsWith(`${teamId}-`)).toBe(true);
        expect(Object.keys(s).sort()).toEqual(['embeddable', 'headline', 'id', 'publishedAt', 'sources', 'summary', 'url']);
        for (const source of s.sources) expect(Object.keys(source).sort()).toEqual(['name', 'url']);
      }
    }
    // The status words are exactly the old ones.
    expect((body.teams['nfl-lions'] as { status: string }).status).toBe('ready');
    expect((body.teams['nfl-packers'] as { status: string }).status).toBe('pending');
    expect((body.teams['nfl-nope'] as { status: string }).status).toBe('not-covered');
  });
});

describe('FFB-365 contract: GET /v1/scouting-report', () => {
  async function seedScoutingStore(lions: Story[], pistons: Story[], packers: Story[] = []) {
    const { store, kv } = memoryKv();
    const updatedAt = '2026-11-02T11:00:00.000Z';
    await seedLeague(kv, 'NFL', [LIONS, PACKERS], [
      { teamId: 'nfl-lions', updatedAt, stories: lions },
      ...(packers.length > 0 ? [{ teamId: 'nfl-packers', updatedAt, stories: packers }] : []),
    ]);
    await seedLeague(kv, 'NBA', [PISTONS], [{ teamId: 'nba-pistons', updatedAt, stories: pistons }]);
    return memoryEnv(store);
  }

  it('answers the sample response for slot morning: stable id, title, teaser, items, teams', async () => {
    const env = await seedScoutingStore(LIONS_STORIES, PISTONS_STORIES);
    const result = await buildScoutingReport(env, ['nfl-lions', 'nba-pistons'], 'morning', NOW - 24 * 3_600_000, { now: () => NOW });
    expect(result).toEqual(SAMPLE_SCOUTING_RESPONSE);
    // The id is stable for the same stories: the app uses it to avoid repeating a report.
    const again = await buildScoutingReport(env, ['nfl-lions', 'nba-pistons'], 'morning', NOW - 24 * 3_600_000, { now: () => NOW });
    expect(again).toEqual(result);
  });

  it('answers skip when nothing is newer than since', async () => {
    const env = await seedScoutingStore(LIONS_STORIES, PISTONS_STORIES);
    const result = await buildScoutingReport(env, ['nfl-lions', 'nba-pistons'], 'morning', NOW, { now: () => NOW });
    expect(result).toMatchObject({ status: 'skip' });
  });

  it('never looks back more than 48 hours, whatever since says', async () => {
    const fresh = story({ id: 'nfl-lions-fresh47', headline: 'Lions story from 47 hours ago', url: 'https://example.com/47', publishedAt: isoHoursAgo(47) });
    const stale = story({ id: 'nfl-lions-stale49', headline: 'Lions story from 49 hours ago', url: 'https://example.com/49', publishedAt: isoHoursAgo(49) });
    const env = await seedScoutingStore([fresh, stale], []);
    const result = await buildScoutingReport(env, ['nfl-lions'], 'morning', NOW - 72 * 3_600_000, { now: () => NOW });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.report.items.map((item) => item.storyId)).toEqual(['nfl-lions-fresh47']);
    }
  });

  it('picks at most 5, at most 2 per team', async () => {
    const bySources = (teamId: string, count: number) =>
      story({ id: `${teamId}-cap${count}`, headline: `${teamId} story with ${count} sources`, url: `https://example.com/${teamId}-${count}`, publishedAt: isoHoursAgo(1), sources: Array.from({ length: count }, (_, i) => ({ name: `Outlet ${i}`, url: `https://example.com/${teamId}-${count}-${i}` })) });
    const env = await seedScoutingStore(
      [bySources('nfl-lions', 4), bySources('nfl-lions', 3), bySources('nfl-lions', 2)],
      [bySources('nba-pistons', 4), bySources('nba-pistons', 3), bySources('nba-pistons', 2)],
      [bySources('nfl-packers', 4)],
    );
    const result = await buildScoutingReport(env, ['nfl-lions', 'nba-pistons', 'nfl-packers'], 'morning', NOW - 24 * 3_600_000, { now: () => NOW });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.report.items.map((item) => item.storyId)).toEqual(['nfl-lions-cap4', 'nba-pistons-cap4', 'nfl-packers-cap4', 'nfl-lions-cap3', 'nba-pistons-cap3']);
    }
  });
});
