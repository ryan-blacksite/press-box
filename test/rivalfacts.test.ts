/**
 * FV2-234: the rival facts dataset and its separation from the news stories.
 * 1. data/rivalfacts/nfl.json: 5 facts for each of the 32 NFL teams, in the "Fun fact." voice, each with its source page.
 * 2. FV2-239: data/rivalfacts/mlb.json does the same for the 30 MLB teams, in its own `rivalfacts:mlb` item.
 *    FV2-235: data/rivalfacts/nhl.json does the same for the 32 NHL teams, plus teams-only / no-stat-line guards.
 * 3. Facts and stories never mix: a fact is never in a story bundle (bundle:nfl, bundle:mlb), the writer's code never touches the
 *    facts, and the facts Worker never reads a bundle.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBundles } from '../src/bundles';
import type { KvStore } from '../src/kv';
import { publishRivalFacts, loadRivalFacts, rivalFactsFile } from '../src/rivalfacts/publish';
import { bundleKey } from '../src/shared/bundle';
import {
  FACT_PREFIX,
  looksLikeRivalFact,
  parseRivalFacts,
  rivalFactsKey,
  serializeRivalFacts,
  toPublicPayload,
  validateRivalFacts,
  type RivalFactEntry,
  type RivalFactsFile,
} from '../src/shared/rivalfacts';
import { TEAMS } from '../src/shared/teams';
import type { Story } from '../src/shared/types';
import { handle, type Env } from '../workers/rival-facts/src/index';

const NFL = TEAMS.filter((team) => team.league === 'NFL');
const NFL_IDS = NFL.map((team) => team.id);
const file: RivalFactsFile = JSON.parse(readFileSync(rivalFactsFile('nfl'), 'utf8'));
const allFacts = Object.entries(file.teams).flatMap(([teamId, facts]) => facts.map((fact) => ({ teamId, fact })));
const NBA = TEAMS.filter((team) => team.league === 'NBA');
const nbaFile: RivalFactsFile = JSON.parse(readFileSync(rivalFactsFile('nba'), 'utf8'));
const nbaFacts = Object.entries(nbaFile.teams).flatMap(([teamId, facts]) => facts.map((fact) => ({ teamId, fact })));

describe('the NBA rival facts file', () => {
  it('contains five sourced facts for each NBA team', () => {
    expect(NBA).toHaveLength(30);
    expect(nbaFile.league).toBe('nba');
    expect(validateRivalFacts(nbaFile, NBA.map((team) => team.id))).toEqual([]);
    expect(nbaFacts).toHaveLength(150);
    expect(new Set(nbaFacts.map(({ fact }) => fact.text)).size).toBe(150);
    for (const { teamId, fact } of nbaFacts) {
      const team = NBA.find((candidate) => candidate.id === teamId)!;
      expect(fact.text.startsWith(FACT_PREFIX)).toBe(true);
      expect(fact.text.includes(team.name) || (teamId === 'nba-hornets' && fact.text.includes('Charlotte Bobcats')), fact.text).toBe(true);
      expect(fact.sourceUrl).toMatch(/^https:\/\//);
      expect(fact.sourceName.length).toBeGreaterThan(2);
      expect(fact.claim.length).toBeGreaterThan(10);
      expect(fact.proof.length).toBeGreaterThan(3);
      expect(fact.checkedOn).toMatch(/^2026-11-\d\d$/);
    }
  });
});

function memoryKv(initial: Record<string, string> = {}): KvStore & { data: Map<string, string>; gets: string[]; puts: string[] } {
  const data = new Map(Object.entries(initial));
  const gets: string[] = [];
  const puts: string[] = [];
  return {
    data,
    gets,
    puts,
    async get(key) {
      gets.push(key);
      return data.get(key) ?? null;
    },
    async put(key, value) {
      puts.push(key);
      data.set(key, value);
    },
  };
}

describe('the NFL rival facts file', () => {
  it('is publishable: 5 facts for each of the 32 NFL teams, nothing else', () => {
    expect(NFL_IDS).toHaveLength(32);
    expect(validateRivalFacts(file, NFL_IDS)).toEqual([]);
    expect(allFacts).toHaveLength(160);
  });

  it('every fact is in the "Fun fact." voice and names its team', () => {
    for (const { teamId, fact } of allFacts) {
      const team = NFL.find((candidate) => candidate.id === teamId)!;
      expect(fact.text.startsWith(FACT_PREFIX), fact.text).toBe(true);
      const nickname = team.name.split(' ').slice(-1)[0];
      expect(fact.text.includes(nickname) || (nickname === 'Buccaneers' && fact.text.includes('Bucs')) || (nickname === 'Titans' && fact.text.includes('Oilers')) || fact.text.includes(team.name) || fact.text.includes(team.name.split(' ')[0]) || fact.text.includes(team.city), `${teamId}: ${fact.text}`).toBe(true);
    }
  });

  it('every fact keeps its source page, the claim that was checked, a proof snippet and when it was checked', () => {
    for (const { teamId, fact } of allFacts) {
      expect(fact.sourceUrl, `${teamId}: ${fact.text}`).toMatch(/^https:\/\//);
      expect(fact.sourceName.length).toBeGreaterThan(2);
      expect(fact.claim.length).toBeGreaterThan(10);
      expect(fact.proof.length).toBeGreaterThan(3);
      expect(fact.checkedOn).toMatch(/^2026-11-\d\d$/);
    }
  });

  it('has no fact twice', () => {
    expect(new Set(allFacts.map(({ fact }) => fact.text)).size).toBe(allFacts.length);
  });

  it('rejects a file that is short, misses a team, or has a fact outside the voice', () => {
    const copy = JSON.parse(JSON.stringify(file)) as RivalFactsFile;
    copy.teams['nfl-lions'].pop();
    copy.teams['nfl-bears'][0] = { ...copy.teams['nfl-bears'][0], text: 'The Bears are bad.' };
    delete copy.teams['nfl-jets'];
    const problems = validateRivalFacts(copy, NFL_IDS);
    expect(problems).toContain('nfl-lions: 4 facts, needs 5');
    expect(problems).toContain('nfl-jets: no facts');
    expect(problems.some((problem) => problem.startsWith('nfl-bears[0]: text must start'))).toBe(true);
    const bad = { ...copy, teams: { ...copy.teams, 'nfl-bears': copy.teams['nfl-bears'].map((fact: RivalFactEntry) => ({ ...fact, sourceUrl: 'http://example.com/x' })) } };
    expect(validateRivalFacts(bad, NFL_IDS).some((problem) => problem.includes('sourceUrl must be an https'))).toBe(true);
  });
});

const MLB = TEAMS.filter((team) => team.league === 'MLB');
const MLB_IDS = MLB.map((team) => team.id);
const mlbFile: RivalFactsFile = JSON.parse(readFileSync(rivalFactsFile('mlb'), 'utf8'));
const mlbFacts = Object.entries(mlbFile.teams).flatMap(([teamId, facts]) => facts.map((fact) => ({ teamId, fact })));

describe('the MLB rival facts file', () => {
  it('is publishable: 5 facts for each of the 30 MLB teams, nothing else', () => {
    expect(MLB_IDS).toHaveLength(30);
    expect(validateRivalFacts(mlbFile, MLB_IDS)).toEqual([]);
    expect(mlbFacts).toHaveLength(150);
  });

  it('every fact is in the "Fun fact." voice and names its team', () => {
    for (const { teamId, fact } of mlbFacts) {
      const team = MLB.find((candidate) => candidate.id === teamId)!;
      // "Boston Red Sox" -> "Red Sox"; others use the last word ("Diamondbacks", "Rangers").
      const nickname = team.name.endsWith('Sox') ? team.name.split(' ').slice(-2).join(' ') : team.name.split(' ').slice(-1)[0];
      expect(fact.text.startsWith(FACT_PREFIX), fact.text).toBe(true);
      expect(
        fact.text.includes(nickname) ||
          (nickname === 'Athletics' && fact.text.includes("A's")) ||
          (nickname === 'Guardians' && fact.text.includes('Indians')) ||
          (nickname === 'Rangers' && fact.text.includes('Senators')) ||
          (nickname === 'Nationals' && fact.text.includes('Nats')) ||
          (nickname === 'Red Sox' && fact.text.includes('Sox')) ||
          (nickname === 'White Sox' && fact.text.includes('Sox')) ||
          fact.text.includes(team.name) ||
          fact.text.includes(team.name.split(' ')[0]) ||
          fact.text.includes(team.city),
        `${teamId}: ${fact.text}`,
      ).toBe(true);
    }
  });

  it('every fact keeps its source page, the claim that was checked, a proof snippet and when it was checked', () => {
    for (const { teamId, fact } of mlbFacts) {
      expect(fact.sourceUrl, `${teamId}: ${fact.text}`).toMatch(/^https:\/\//);
      expect(fact.sourceName.length).toBeGreaterThan(2);
      expect(fact.claim.length).toBeGreaterThan(10);
      expect(fact.proof.length).toBeGreaterThan(3);
      expect(fact.checkedOn).toMatch(/^2026-11-\d\d$/);
    }
  });

  it('has no fact twice', () => {
    expect(new Set(mlbFacts.map(({ fact }) => fact.text)).size).toBe(mlbFacts.length);
  });

  it('rejects a file that is short, misses a team, or has a fact outside the voice', () => {
    const copy = JSON.parse(JSON.stringify(mlbFile)) as RivalFactsFile;
    copy.teams['mlb-tigers'].pop();
    copy.teams['mlb-cubs'][0] = { ...copy.teams['mlb-cubs'][0], text: 'The Cubs are bad.' };
    delete copy.teams['mlb-rays'];
    const problems = validateRivalFacts(copy, MLB_IDS);
    expect(problems).toContain('mlb-tigers: 4 facts, needs 5');
    expect(problems).toContain('mlb-rays: no facts');
    expect(problems.some((problem) => problem.startsWith('mlb-cubs[0]: text must start'))).toBe(true);
    const bad = { ...copy, teams: { ...copy.teams, 'mlb-cubs': copy.teams['mlb-cubs'].map((fact: RivalFactEntry) => ({ ...fact, sourceUrl: 'http://example.com/x' })) } };
    expect(validateRivalFacts(bad, MLB_IDS).some((problem) => problem.includes('sourceUrl must be an https'))).toBe(true);
  });

  it('the MLB facts publish to their own item, never the story bundle, and their payload keeps only text and source', async () => {
    const kv = memoryKv({ [bundleKey('mlb')]: '{"stories":"untouched"}' });
    expect(await publishRivalFacts('mlb', kv, { dryRun: true })).toMatchObject({ key: 'rivalfacts:mlb', wrote: false });
    expect(kv.puts).toEqual([]);
    expect(await publishRivalFacts('mlb', kv, { dryRun: false })).toMatchObject({ key: 'rivalfacts:mlb', wrote: true });
    expect(kv.data.get(bundleKey('mlb'))).toBe('{"stories":"untouched"}');
    expect(kv.gets.every((key) => key === 'rivalfacts:mlb')).toBe(true);
    expect(() => loadRivalFacts('mlb', rivalFactsFile('mlb').replace('mlb.json', 'missing.json'))).toThrow();
    const payload = toPublicPayload(mlbFile);
    expect(Object.keys(payload.teams)).toEqual([...MLB_IDS].sort());
    expect(Object.keys(payload.teams['mlb-cubs'][0]).sort()).toEqual(['source', 'text']);
  });
});

const NHL = TEAMS.filter((team) => team.league === 'NHL');
const NHL_IDS = NHL.map((team) => team.id);
const nhlFile: RivalFactsFile = JSON.parse(readFileSync(rivalFactsFile('nhl'), 'utf8'));
const nhlFacts = Object.entries(nhlFile.teams).flatMap(([teamId, facts]) => facts.map((fact) => ({ teamId, fact })));
// How fans say a club's name when it is not the last word of the full name.
const NHL_NICKNAMES: Record<string, string[]> = {
  'nhl-bluejackets': ['Jackets', 'Blue Jackets'],
  'nhl-redwings': ['Wings', 'Red Wings'],
  'nhl-mapleleafs': ['Leafs', 'Maple Leafs'],
  'nhl-goldenknights': ['Golden Knights', 'Knights'],
  'nhl-canadiens': ['Habs'],
  'nhl-ducks': ['Mighty Ducks'],
};

describe('the NHL rival facts file (FV2-235)', () => {
  it('is publishable: 5 facts for each of the 32 NHL teams, nothing else', () => {
    expect(NHL_IDS).toHaveLength(32);
    expect(nhlFile.league).toBe('nhl');
    expect(validateRivalFacts(nhlFile, NHL_IDS)).toEqual([]);
    expect(nhlFacts).toHaveLength(160);
    for (const id of NHL_IDS) expect(nhlFile.teams[id], id).toHaveLength(5);
  });

  it('every fact is in the "Fun fact." voice, names its team and fits the text limit', () => {
    for (const { teamId, fact } of nhlFacts) {
      const team = NHL.find((candidate) => candidate.id === teamId)!;
      const names = [team.name, team.city, team.name.split(' ').slice(-1)[0], team.name.split(' ')[0], ...(NHL_NICKNAMES[teamId] ?? [])];
      expect(fact.text.startsWith(FACT_PREFIX), fact.text).toBe(true);
      expect(fact.text.length, fact.text).toBeLessThanOrEqual(200);
      expect(names.some((name) => fact.text.includes(name)), `${teamId}: ${fact.text}`).toBe(true);
    }
  });

  it('every fact keeps its source page, the claim that was checked, a proof snippet and when it was checked', () => {
    for (const { teamId, fact } of nhlFacts) {
      expect(fact.sourceUrl, `${teamId}: ${fact.text}`).toMatch(/^https:\/\//);
      expect(fact.sourceName.length).toBeGreaterThan(2);
      expect(fact.claim.length).toBeGreaterThan(10);
      expect(fact.proof.length, `${teamId}: ${fact.text}`).toBeGreaterThan(3);
      expect(fact.asOf.length).toBeGreaterThan(3);
      expect(fact.checkedOn).toMatch(/^2026-11-\d\d$/);
    }
  });

  it('keeps raw wiki markup and footnotes out of the proof snippets', () => {
    for (const { teamId, fact } of nhlFacts) expect(fact.proof, `${teamId}: ${fact.text}`).not.toMatch(/<ref|\{\{|<!--|\[\[|\]\]/);
  });

  it('has no fact twice, inside the NHL file or against the NFL file', () => {
    expect(new Set(nhlFacts.map(({ fact }) => fact.text)).size).toBe(nhlFacts.length);
    const nfl = new Set(allFacts.map(({ fact }) => fact.text));
    for (const { fact } of nhlFacts) expect(nfl.has(fact.text), fact.text).toBe(false);
  });

  it('is about teams only, never a bare stat line, and never rude (the ticket rules a test can see)', () => {
    for (const { teamId, fact } of nhlFacts) {
      const body = fact.text.slice(FACT_PREFIX.length);
      expect(body, `${teamId}: a win-loss-overtime record is a stat line`).not.toMatch(/\d+\s*[–-]\s*\d+\s*[–-]\s*\d+/);
      expect(body, `${teamId}: swearing`).not.toMatch(/\b(f-+g|fuck\w*|shit\w*|bitch\w*|damn\w*)\b/i);
      expect(body, `${teamId}: a person is quoted`).not.toMatch(/\b(said|says|told|declared|promised|admitted)\b/i);
    }
  });

  it('rejects an NHL file that is short, misses a team, or has a fact outside the voice', () => {
    const copy = JSON.parse(JSON.stringify(nhlFile)) as RivalFactsFile;
    copy.teams['nhl-bruins'].pop();
    copy.teams['nhl-kings'][0] = { ...copy.teams['nhl-kings'][0], text: 'The Kings are bad.' };
    delete copy.teams['nhl-jets'];
    const problems = validateRivalFacts(copy, NHL_IDS);
    expect(problems).toContain('nhl-bruins: 4 facts, needs 5');
    expect(problems).toContain('nhl-jets: no facts');
    expect(problems.some((problem) => problem.startsWith('nhl-kings[0]: text must start'))).toBe(true);
    // an NFL team id inside an NHL file is refused too
    expect(validateRivalFacts({ ...nhlFile, teams: { ...nhlFile.teams, 'nfl-lions': nhlFile.teams['nhl-bruins'] } }, NHL_IDS)).toContain('nfl-lions: not a team of this league');
  });
});

describe('the public payload', () => {
  it('keeps only the text and the source, in a canonical order, and reads back the same', () => {
    const payload = toPublicPayload(file);
    expect(Object.keys(payload.teams)).toEqual([...NFL_IDS].sort());
    const text = serializeRivalFacts(payload);
    expect(text).not.toContain('"proof"');
    expect(text).not.toContain('"claim"');
    expect(parseRivalFacts(text)).toEqual(payload);
    expect(Object.keys(payload.teams['nfl-lions'][0]).sort()).toEqual(['source', 'text']);
  });

  it('parseRivalFacts never throws and drops odd entries', () => {
    expect(parseRivalFacts(null)).toBeNull();
    expect(parseRivalFacts('nope')).toBeNull();
    expect(parseRivalFacts('{"v":1,"league":"nfl","teams":[]}')).toBeNull();
    const odd = parseRivalFacts(JSON.stringify({ v: 1, league: 'nfl', teams: { a: [{ text: 'Fun fact. ok', source: { name: 'S', url: 'https://x.test/p' } }, { text: 5 }, { text: 'x', source: { name: 'S', url: 'http://x.test' } }], b: 'no' } }));
    expect(odd?.teams.a).toHaveLength(1);
    expect(odd?.teams.b).toBeUndefined();
  });
});

describe('facts and news stories stay completely apart', () => {
  it('a fact has its own key, never a bundle key', () => {
    expect(rivalFactsKey('NFL')).toBe('rivalfacts:nfl');
    expect(rivalFactsKey('nfl')).not.toBe(bundleKey('nfl'));
    expect(rivalFactsKey('nfl').startsWith('bundle:')).toBe(false);
  });

  it('FAILS if a fact ever ends up in a story bundle: the real writer path stores stories only', async () => {
    const kv = memoryKv();
    const bundles = createBundles(kv, { dryRun: false });
    const lions = NFL.find((team) => team.id === 'nfl-lions')!;
    await bundles.load('NFL', NFL);
    const story: Story = { id: 'nfl-lions-1', headline: 'Lions beat Vikings', summary: 'Detroit won at home.', sources: [], url: 'https://www.espn.com/x', embeddable: false, publishedAt: '2026-11-12T10:00:00.000Z' };
    bundles.set(lions, { teamId: lions.id, updatedAt: '2026-11-12T10:00:00.000Z', stories: [story] });
    await bundles.flushAll();
    const stored = kv.data.get(bundleKey('nfl'))!;
    expect(stored).toBeTruthy();
    for (const { fact } of allFacts) expect(stored.includes(fact.text), fact.text).toBe(false);
    expect(looksLikeRivalFact(stored)).toBe(false);
    expect([...kv.data.keys()].every((key) => !key.startsWith('rivalfacts:'))).toBe(true);
  });

  it('the writer refuses to store a rival fact as a story, whatever put it there', async () => {
    const kv = memoryKv();
    const bundles = createBundles(kv, { dryRun: false });
    const lions = NFL.find((team) => team.id === 'nfl-lions')!;
    await bundles.load('NFL', NFL);
    const planted: Story = { id: 'x', headline: allFacts[0].fact.text, summary: allFacts[1].fact.text, sources: [], url: 'https://www.espn.com/x', embeddable: false, publishedAt: '2026-11-12T10:00:00.000Z' };
    bundles.set(lions, { teamId: lions.id, updatedAt: '2026-11-12T10:00:00.000Z', stories: [planted] });
    await expect(bundles.flush('NFL')).rejects.toThrow(/rival fact is in a story bundle/);
    expect(kv.puts).toEqual([]);
  });

  it('no writer code imports or names the facts (only the facts files, their publisher and their Worker do)', () => {
    const own = new Set(['src/shared/rivalfacts.ts', 'src/rivalfacts/publish.ts', 'src/rivalfacts/main.ts']);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : /\.ts$/.test(entry.name) ? [join(dir, entry.name)] : []));
    for (const path of walk('src')) {
      const name = path.replace(/\\/g, '/');
      if (own.has(name)) continue;
      const text = readFileSync(path, 'utf8');
      // bundles.ts only names the voice, to refuse it; nothing may import the facts or read their key.
      expect(/rivalfacts|rivalFacts/i.test(text.replace(/rivalfacts:<league>[^\n]*|rivalfacts:\$\{league[^\n]*|shared\/rivalfacts\.ts/g, '')), `${name} reaches into the facts`).toBe(false);
    }
  });

  it('publishing writes the one facts item, and only when it changed; a dry run writes nothing', async () => {
    const kv = memoryKv({ [bundleKey('nfl')]: '{"stories":"untouched"}' });
    expect(await publishRivalFacts('nfl', kv, { dryRun: true })).toMatchObject({ key: 'rivalfacts:nfl', wrote: false });
    expect(kv.puts).toEqual([]);
    expect(await publishRivalFacts('nfl', kv, { dryRun: false })).toMatchObject({ key: 'rivalfacts:nfl', wrote: true });
    expect(await publishRivalFacts('nfl', kv, { dryRun: false })).toMatchObject({ wrote: false });
    expect(kv.puts).toEqual(['rivalfacts:nfl']);
    expect(kv.data.get(bundleKey('nfl'))).toBe('{"stories":"untouched"}');
    expect(kv.gets.every((key) => key === 'rivalfacts:nfl')).toBe(true);
  });

  it('loadRivalFacts refuses a file that is not complete', () => {
    expect(() => loadRivalFacts('nfl', rivalFactsFile('nfl').replace('nfl.json', 'missing.json'))).toThrow();
  });
});

describe('the facts Worker', () => {
  const published = serializeRivalFacts(toPublicPayload(file));
  const env = (kv: KvStore): Env => ({ RIVAL_FACTS_KV: kv, ALLOWED_ORIGIN: 'https://dev.fanslikeyou.com' });
  const call = (kv: KvStore, path: string, origin = 'https://dev.fanslikeyou.com') => handle(new Request(`https://rival.test${path}`, { headers: { origin } }), env(kv));

  it('answers a team with its 5 facts, reading only the facts item and never a story bundle', async () => {
    const kv = memoryKv({ 'rivalfacts:nfl': published, [bundleKey('nfl')]: '{"v":1,"league":"nfl","teams":{}}' });
    const response = await call(kv, '/v1/rival-facts?team=nfl-lions');
    const body = (await response.json()) as { teams: Record<string, { status: string; facts: unknown[] }> };
    expect(response.status).toBe(200);
    expect(body.teams['nfl-lions'].status).toBe('ready');
    expect(body.teams['nfl-lions'].facts).toHaveLength(5);
    expect(kv.gets).toEqual(['rivalfacts:nfl']);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://dev.fanslikeyou.com');
  });

  it('says not-covered for another league or team, pending when nothing is stored or the read fails, and gives no CORS to a stranger', async () => {
    const kv = memoryKv({ 'rivalfacts:nfl': published });
    const other = (await (await call(kv, '/v1/rival-facts?teams=nba-pistons,nfl-nope')).json()) as { teams: Record<string, { status: string }> };
    expect(other.teams['nba-pistons'].status).toBe('not-covered');
    expect(other.teams['nfl-nope'].status).toBe('not-covered');
    const empty = (await (await call(memoryKv(), '/v1/rival-facts?team=nfl-lions')).json()) as { teams: Record<string, { status: string }> };
    expect(empty.teams['nfl-lions'].status).toBe('pending');
    const broken: KvStore = { get: async () => { throw new Error('kv down'); }, put: async () => {} };
    const failed = await call(broken, '/v1/rival-facts?team=nfl-lions');
    expect(((await failed.json()) as { teams: Record<string, { status: string }> }).teams['nfl-lions'].status).toBe('pending');
    expect(failed.headers.get('cache-control')).toBe('no-store');
    expect((await call(kv, '/v1/rival-facts?team=nfl-lions', 'https://evil.test')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a missing or oversized team list and an unknown path, and never writes', async () => {
    const kv = memoryKv({ 'rivalfacts:nfl': published });
    expect((await call(kv, '/v1/rival-facts')).status).toBe(400);
    expect((await call(kv, `/v1/rival-facts?teams=${NFL_IDS.slice(0, 13).join(',')}`)).status).toBe(400);
    expect((await call(kv, '/v1/other')).status).toBe(404);
    expect((await handle(new Request('https://rival.test/v1/rival-facts?team=nfl-lions', { method: 'POST' }), env(kv))).status).toBe(405);
    expect(kv.puts).toEqual([]);
  });

  it('its source never mentions a story bundle', () => {
    expect(readFileSync('workers/rival-facts/src/index.ts', 'utf8')).not.toMatch(/bundleKey|bundle:|parseBundle/);
  });
});

describe('the NHL facts stay apart from the news and are not served until the Worker is switched on (FV2-235)', () => {
  it('have their own key, a canonical public payload without the proof, and read back the same', () => {
    expect(rivalFactsKey('NHL')).toBe('rivalfacts:nhl');
    expect(rivalFactsKey('nhl')).not.toBe(bundleKey('nhl'));
    const payload = toPublicPayload(nhlFile);
    expect(Object.keys(payload.teams)).toEqual([...NHL_IDS].sort());
    const text = serializeRivalFacts(payload);
    expect(text).not.toContain('"proof"');
    expect(text).not.toContain('"claim"');
    expect(parseRivalFacts(text)).toEqual(payload);
    expect(Object.keys(payload.teams['nhl-bruins'][0]).sort()).toEqual(['source', 'text']);
  });

  it('the writer refuses to store an NHL fact as a story, whatever put it there', async () => {
    const kv = memoryKv();
    const bundles = createBundles(kv, { dryRun: false });
    const bruins = NHL.find((team) => team.id === 'nhl-bruins')!;
    await bundles.load('NHL', NHL);
    const planted: Story = { id: 'x', headline: nhlFacts[0].fact.text, summary: nhlFacts[1].fact.text, sources: [], url: 'https://www.espn.com/x', embeddable: false, publishedAt: '2026-11-12T10:00:00.000Z' };
    bundles.set(bruins, { teamId: bruins.id, updatedAt: '2026-11-12T10:00:00.000Z', stories: [planted] });
    await expect(bundles.flush('NHL')).rejects.toThrow(/rival fact is in a story bundle/);
    expect(kv.puts).toEqual([]);
  });

  it('a dry run publishes nothing and a real run would write only rivalfacts:nhl (checked on a memory store, never the real one)', async () => {
    const kv = memoryKv({ [bundleKey('nhl')]: '{"stories":"untouched"}' });
    expect(await publishRivalFacts('nhl', kv, { dryRun: true })).toMatchObject({ key: 'rivalfacts:nhl', wrote: false });
    expect(kv.puts).toEqual([]);
    expect(await publishRivalFacts('nhl', kv, { dryRun: false })).toMatchObject({ key: 'rivalfacts:nhl', wrote: true });
    expect(kv.puts).toEqual(['rivalfacts:nhl']);
    expect(kv.data.get(bundleKey('nhl'))).toBe('{"stories":"untouched"}');
  });

  it('the facts Worker still says not-covered for NHL teams: turning NHL on there is a separate, deliberate change', async () => {
    const kv = memoryKv({ 'rivalfacts:nhl': serializeRivalFacts(toPublicPayload(nhlFile)) });
    const env: Env = { RIVAL_FACTS_KV: kv, ALLOWED_ORIGIN: 'https://dev.fanslikeyou.com' };
    const response = await handle(new Request('https://rival.test/v1/rival-facts?team=nhl-bruins', { headers: { origin: 'https://dev.fanslikeyou.com' } }), env);
    const body = (await response.json()) as { teams: Record<string, { status: string }> };
    expect(body.teams['nhl-bruins'].status).toBe('not-covered');
    expect(kv.gets).toEqual([]);
  });
});
