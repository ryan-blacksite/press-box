/**
 * Purpose: read the Press Box store from the Worker (FV2-3; reads only since FV2-16; crash-proof since FV2-28; bundled since FV2-47).
 * Owns: teamKey(), parseTeamStories(), readTeamResult(), readTeam() and the short bundle cache.
 * Notes: The store is Cloudflare KV, written once a day by the writer job (scripts/press-box, GitHub Actions) and read here. FV2-47:
 *   a league's teams are ONE item, `bundle:<league>` (bundle.ts), so a request reads one item per league it touches, not two per team,
 *   and the free plan's 1,000 writes a day are not spent on 290 per-team items. The Worker never writes to KV, on a fan's request or
 *   otherwise. A bundle is kept in memory for BUNDLE_CACHE_MS (and a read in flight is shared by the requests that arrive during it), so
 *   a busy minute reads each league's bundle once per isolate; a read that failed is never kept. Until the writer has made a league's
 *   bundle, that league's teams are read from the old `team:<id>` item, once the bundle exists they never are (a team missing from a
 *   bundle is simply not stored yet).
 *   FV2-28: nothing in here throws. A KV read that errors (the binding missing, a Cloudflare KV outage or rate limit), a value
 *   that is not JSON, and a value with the wrong shape all mean "nothing readable for this team": readTeamResult() says which
 *   (`failed` when the read itself errored, so the caller can answer `pending` without caching it), and a stored story is
 *   cleaned to the fields the app reads, so one odd story cannot take a team's other stories (or the request) down with it.
 */
import { bundleKey, legacyKey, parseBundle, type Bundle } from './bundle';
import type { Env, Story, TeamStories } from './types';
import { TEAMS } from './teams';
import { filterStoriesForTeam } from './storySport';

/** How long a league's bundle is kept in memory. Short, so a new writer run shows within the minute; long enough that reads stay low. */
export const BUNDLE_CACHE_MS = 60_000;

export const teamKey = legacyKey;

const isText = (value: unknown): value is string => typeof value === 'string';

function cleanStory(raw: unknown): Story | null {
  if (!raw || typeof raw !== 'object') return null;
  const story = raw as Record<string, unknown>;
  if (!isText(story.id) || !isText(story.headline) || !isText(story.url)) return null;
  const sources = (Array.isArray(story.sources) ? story.sources : [])
    .filter((source): source is { name: string; url: string } => Boolean(source) && isText((source as { name?: unknown }).name) && isText((source as { url?: unknown }).url))
    .map((source) => ({ name: source.name, url: source.url }));
  return {
    id: story.id,
    headline: story.headline,
    summary: isText(story.summary) ? story.summary : '',
    sources,
    url: story.url,
    embeddable: story.embeddable === true,
    publishedAt: isText(story.publishedAt) && Number.isFinite(Date.parse(story.publishedAt)) ? story.publishedAt : '',
  };
}

/** A stored team value as the app reads it, or null when it is not a TeamStories or holds only unreadable stories. */
export function parseTeamStoriesValue(value: unknown, teamId: string): TeamStories | null {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Record<string, unknown>;
  if (!Array.isArray(stored.stories)) return null;
  const team = TEAMS.find((candidate) => candidate.id === teamId);
  const stories = stored.stories.map(cleanStory).filter((story): story is Story => story !== null);
  if (stored.stories.length > 0 && stories.length === 0) return null;
  return { teamId, updatedAt: isText(stored.updatedAt) ? stored.updatedAt : '', stories: team ? filterStoriesForTeam(stories, team) : stories };
}

/** The stored text as the app reads it, or null when it is not JSON, not a TeamStories, or holds only unreadable stories. */
export function parseTeamStories(raw: string, teamId: string): TeamStories | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseTeamStoriesValue(value, teamId);
}

export type TeamRead = { kind: 'stored'; value: TeamStories } | { kind: 'empty' } | { kind: 'failed' };

type BundleRead = { kind: 'bundle'; bundle: Bundle } | { kind: 'absent' } | { kind: 'failed' };

const bundleCache = new Map<string, { at: number; read: Promise<BundleRead> }>();

/** Forget every cached bundle (tests). */
export function clearBundleCache(): void {
  bundleCache.clear();
}

async function fetchBundle(env: Env, league: string): Promise<BundleRead> {
  let raw: string | null;
  try {
    raw = await env.PRESS_BOX_KV.get(bundleKey(league));
  } catch (error) {
    console.error(JSON.stringify({ event: 'press-box-kv-read-failed', bundle: bundleKey(league), message: error instanceof Error ? error.message : String(error) }));
    return { kind: 'failed' };
  }
  if (!raw) return { kind: 'absent' };
  const bundle = parseBundle(raw);
  if (!bundle) {
    console.error(JSON.stringify({ event: 'press-box-unreadable-bundle', bundle: bundleKey(league) }));
    return { kind: 'absent' };
  }
  return { kind: 'bundle', bundle };
}

/** A league's bundle: from memory when read in the last BUNDLE_CACHE_MS (or being read now), else one KV read. A failed read is not kept. */
async function readBundle(env: Env, league: string, now: number): Promise<BundleRead> {
  const key = league.toLowerCase();
  const kept = bundleCache.get(key);
  if (kept && now - kept.at < BUNDLE_CACHE_MS) return kept.read;
  const read = fetchBundle(env, league);
  const entry: { at: number; read: Promise<BundleRead> } = { at: now, read };
  bundleCache.set(key, entry);
  void read.then((result) => {
    // A failed read is never kept: the next ask reads again.
    if (result.kind === 'failed') entry.at = Number.NEGATIVE_INFINITY;
  });
  return read;
}

/** The pre-bundle read of one team, for a league whose bundle the writer has not made yet. */
async function readLegacyTeam(env: Env, teamId: string): Promise<TeamRead> {
  let raw: string | null;
  try {
    raw = await env.PRESS_BOX_KV.get(legacyKey(teamId));
  } catch (error) {
    console.error(JSON.stringify({ event: 'press-box-kv-read-failed', team: teamId, message: error instanceof Error ? error.message : String(error) }));
    return { kind: 'failed' };
  }
  if (!raw) return { kind: 'empty' };
  const value = parseTeamStories(raw, teamId);
  if (!value) {
    console.error(JSON.stringify({ event: 'press-box-unreadable-value', team: teamId }));
    return { kind: 'empty' };
  }
  return { kind: 'stored', value };
}

/** What the store holds for a team. Never throws: a read that errors is `failed` and is logged. */
export async function readTeamResult(env: Env, teamId: string, now: number = Date.now()): Promise<TeamRead> {
  const team = TEAMS.find((candidate) => candidate.id === teamId);
  if (!team) return { kind: 'empty' };
  const read = await readBundle(env, team.league, now);
  if (read.kind === 'failed') return { kind: 'failed' };
  if (read.kind === 'absent') return readLegacyTeam(env, teamId);
  const entry = read.bundle.teams[teamId];
  if (!entry) return { kind: 'empty' };
  const value = parseTeamStoriesValue(entry, teamId);
  if (!value) {
    console.error(JSON.stringify({ event: 'press-box-unreadable-value', team: teamId }));
    return { kind: 'empty' };
  }
  return { kind: 'stored', value };
}

export async function readTeam(env: Env, teamId: string, now: number = Date.now()): Promise<TeamStories | null> {
  const result = await readTeamResult(env, teamId, now);
  return result.kind === 'stored' ? result.value : null;
}
