/**
 * Purpose: the writer's view of the store as league bundles (FV2-47): load each league once, stage team changes in memory, write a
 *   league's item once, and only when its content changed.
 * Owns: createBundles() and its load(), get(), set(), flush() and flushAll(), and the counts of reads and writes.
 * Notes: Cloudflare's free plan allows 1,000 KV writes a day; one item per team spent ~290 of them in a run (and a re-save of every
 *   skipped team to keep it from expiring). Here nothing is written per team: a team's new stories are staged, and a league's bundle
 *   (bundle:<league>, workers/press-box/src/bundle.ts) is written once, when its teams are done, and ONLY if its canonical text differs
 *   from what is stored. A skipped team stages nothing and its entry simply stays. A league with no bundle yet is seeded from the old
 *   team:<id> items (reads only), so the first run after the change loses nothing; teams outside the run keep what they had. Entries for
 *   teams no longer covered drop out of the bundle. Bundles are stored without an expiry. `writes` is the run's KV write count.
 *   A dry run reads but never writes.
 */
import { bundleKey, parseBundle, serializeBundle, type BundleTeam } from './shared/bundle';
import type { PressBoxTeam } from './shared/teams';
import { parseTeamStories, parseTeamStoriesValue } from './shared/store';
import type { TeamStories } from './shared/types';
import { teamKey, type KvStore } from './kv';

export interface FlushResult {
  key: string;
  wrote: boolean;
  bytes: number;
}

export interface Bundles {
  /** Read a league's bundle (or seed it from the old per-team items). Call once per league before get(). */
  load(league: string, teams: readonly PressBoxTeam[]): Promise<void>;
  /** What is stored for a team, with the stories as the app would read them (nonmatching ones filtered). */
  get(team: PressBoxTeam): TeamStories | null;
  /** The raw stored entry, to count what the reader would drop. */
  raw(team: PressBoxTeam): BundleTeam | null;
  /** Stage a team's new value. Nothing is written until flush(). */
  set(team: PressBoxTeam, value: TeamStories): void;
  /** Write the league's item if its content changed. A no-op for a league already flushed with nothing staged since. */
  flush(league: string): Promise<FlushResult | null>;
  flushAll(): Promise<FlushResult[]>;
  readonly writes: number;
  readonly reads: number;
  readonly written: ReadonlyMap<string, number>;
}

export function createBundles(kv: KvStore | null, options: { dryRun: boolean }): Bundles {
  interface LeagueState {
    members: Set<string>;
    base: string;
    teams: Record<string, BundleTeam>;
    dirty: boolean;
  }
  const leagues = new Map<string, LeagueState>();
  const leagueOf = new Map<string, string>();
  const written = new Map<string, number>();
  let writes = 0;
  let reads = 0;

  return {
    async load(league, teams) {
      const members = new Set(teams.map((team) => team.id));
      for (const id of members) leagueOf.set(id, league);
      const existing = kv ? parseBundle(await kv.get(bundleKey(league))) : null;
      reads += kv ? 1 : 0;
      let stored: Record<string, BundleTeam> = {};
      if (existing) {
        stored = { ...existing.teams };
      } else if (kv) {
        // No bundle yet: seed from the old per-team items so the first bundle holds everything already stored.
        for (const team of teams) {
          const raw = await kv.get(teamKey(team.id));
          reads += 1;
          const parsed = raw ? parseTeamStories(raw, team.id) : null;
          if (parsed) stored[team.id] = { updatedAt: parsed.updatedAt, stories: parsed.stories };
        }
      }
      for (const id of Object.keys(stored)) if (!members.has(id)) delete stored[id];
      // A bundle seeded from the old items is written even if no team changes, or those items would expire with their data.
      leagues.set(league, { members, base: existing ? serializeBundle(league, stored) : '', teams: stored, dirty: !existing && Object.keys(stored).length > 0 });
    },

    get(team) {
      const state = leagues.get(leagueOf.get(team.id) ?? '');
      const entry = state?.teams[team.id];
      return entry ? parseTeamStoriesValue(entry, team.id) : null;
    },

    raw(team) {
      return leagues.get(leagueOf.get(team.id) ?? '')?.teams[team.id] ?? null;
    },

    set(team, value) {
      const state = leagues.get(leagueOf.get(team.id) ?? '');
      if (!state) throw new Error(`League of ${team.id} was not loaded`);
      state.teams[team.id] = { updatedAt: value.updatedAt, stories: value.stories };
      state.dirty = true;
    },

    async flush(league) {
      const state = leagues.get(league);
      if (!state) return null;
      const text = serializeBundle(league, state.teams);
      const key = bundleKey(league);
      // FV2-234: rival facts (rivalfacts:<league>, shared/rivalfacts.ts) are never news. A story in the "Fun fact." voice means a fact got into the writer's path: stop, do not store it.
      if (/"(?:headline|summary)":"\s*Fun fact\./.test(text)) throw new Error(`${key}: a rival fact is in a story bundle; facts live only in their own item (rivalfacts:${league.toLowerCase()})`);
      if (!state.dirty || text === state.base) return { key, wrote: false, bytes: text.length };
      if (!options.dryRun && kv) {
        await kv.put(key, text);
        writes += 1;
        written.set(key, text.length);
      }
      state.base = text;
      state.dirty = false;
      return { key, wrote: !options.dryRun && Boolean(kv), bytes: text.length };
    },

    async flushAll() {
      const results: FlushResult[] = [];
      for (const league of leagues.keys()) {
        const result = await this.flush(league);
        if (result) results.push(result);
      }
      return results;
    },

    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    get written() {
      return written;
    },
  };
}
