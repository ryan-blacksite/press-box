/**
 * Purpose: the Press Box store's layout: one KV item per league, not one per team (FV2-47).
 * Owns: bundleKey(), parseBundle(), serializeBundle() and the Bundle shape. Shared by the writer job (scripts/press-box) and the Worker.
 * Notes: Cloudflare's free plan allows 1,000 KV writes a day. One item per team meant ~290 writes in a run (and again to keep each
 *   alive), so a run could use the whole day's allowance. Now a league's teams live in ONE item, `bundle:<league>` (about 5-8 items for
 *   all ~290 teams), written once per run and only when its content changed. serializeBundle() is canonical (teams sorted, no clock in it),
 *   so "did it change" is a string comparison. The value for a team is exactly what the app reads (updatedAt, stories); the Worker still
 *   answers per team in the same shape, so the app needs no change. The old `team:<id>` items are read only until the first writer
 *   run has made the bundles (legacyKey()), and then expire on their own (their 14-day time-to-live).
 */

export const BUNDLE_VERSION = 1;

export const bundleKey = (league: string): string => `bundle:${league.toLowerCase()}`;
/** The pre-bundle key, read while a league has no bundle yet (and by the writer to seed one). */
export const legacyKey = (teamId: string): string => `team:${teamId}`;

export interface BundleTeam {
  updatedAt: string;
  /** Stories as stored; the reader cleans each one before it reaches the app. */
  stories: unknown[];
}

export interface Bundle {
  v: number;
  league: string;
  teams: Record<string, BundleTeam>;
}

/** The bundle, or null when the text is missing, not JSON or not a bundle. Never throws. */
export function parseBundle(raw: string | null): Bundle | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const stored = value as Record<string, unknown>;
  if (stored.v !== BUNDLE_VERSION || typeof stored.league !== 'string' || !stored.teams || typeof stored.teams !== 'object' || Array.isArray(stored.teams)) return null;
  const teams: Record<string, BundleTeam> = Object.create(null);
  for (const [id, entry] of Object.entries(stored.teams as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const team = entry as Record<string, unknown>;
    if (!Array.isArray(team.stories)) continue;
    teams[id] = { updatedAt: typeof team.updatedAt === 'string' ? team.updatedAt : '', stories: team.stories };
  }
  return { v: BUNDLE_VERSION, league: stored.league, teams };
}

/** Canonical text for a league's teams: team ids sorted, and nothing that changes without the stories changing. */
export function serializeBundle(league: string, teams: Record<string, BundleTeam>): string {
  const sorted: Record<string, BundleTeam> = {};
  for (const id of Object.keys(teams).sort()) sorted[id] = { updatedAt: teams[id].updatedAt, stories: teams[id].stories };
  return JSON.stringify({ v: BUNDLE_VERSION, league, teams: sorted });
}
