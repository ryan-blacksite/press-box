/**
 * Purpose: build a fan's Morning Scouting Report (FV2-4; no AI and no store writes since FV2-16): a short digest, across all
 *   their teams, of the biggest things in the Press Box that are new since their last report.
 * Owns: SLOTS, buildScoutingReport(), pickCandidates() and clampSince().
 * Notes: Built ONLY from the stored Press Box stories (what the daily writer job already wrote), never from new feeds and
 *   never by an AI, so a report costs nothing however many fans ask: each item is the story's headline plus the first sentence of
 *   its own summary. "New" is a story published after `since` (the fan's last report, which the app remembers: this Worker
 *   has no user database). Nothing new -> status `skip`. The pick is the biggest 3-5 (outlet count, then freshness), at most
 *   two per team so every team gets a look. The report id is the same for the same stories, so the app does not repeat a
 *   report. There is one slot, morning; the Midday and Evening reports were removed.
 *
 * Mirror: this file is the same code as workers/press-box/src/scouting.ts in fly-frontend (the Worker that
 *   serves GET /v1/scouting-report), kept here so the writer repo can test the report contract itself.
 *   Only the teams import differs (this repo's teams file instead of the Worker's generated list).
 *   Change the report shape in both places or in neither, like the rest of src/shared/.
 */
import { readTeam } from './store';
import type { Env, Story } from './types';
import { TEAMS } from './teams';

export type Slot = 'morning';
export const SLOTS: readonly Slot[] = ['morning'];
export const SLOT_TITLES: Record<Slot, string> = { morning: 'Morning Scouting Report' };

const MAX_ITEMS = 5;
const MAX_ITEMS_PER_TEAM = 2;
const MAX_LOOKBACK_MS = 48 * 3_600_000;
const MAX_TEASER_CHARS = 120;
const MAX_ITEM_CHARS = 260;

export interface ScoutingItem {
  teamId: string;
  teamName: string;
  storyId: string;
  headline: string;
  /** One or two sentences: what is new. */
  text: string;
  /** The article to open. */
  url: string;
}

export interface ScoutingReport {
  /** Stable for the same slot and the same stories: the app uses it to avoid repeating a report. */
  id: string;
  slot: Slot;
  title: string;
  /** One line for the notification. */
  teaser: string;
  items: ScoutingItem[];
  generatedAt: string;
  teams: string[];
}

export type ScoutingResult = { status: 'skip'; reason: 'nothing-new' } | { status: 'ready'; report: ScoutingReport };

interface Candidate {
  teamId: string;
  teamName: string;
  story: Story;
  score: number;
}

export function clampSince(since: number | null, now: number): number {
  const floor = now - MAX_LOOKBACK_MS;
  if (since === null || !Number.isFinite(since)) return now - 24 * 3_600_000;
  return Math.min(Math.max(since, floor), now);
}

function firstSentence(text: string, max: number): string {
  const match = /^[^.!?]*[.!?]/.exec(text.trim());
  const sentence = (match ? match[0] : text).trim();
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function pickCandidates(candidates: Candidate[]): Candidate[] {
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const perTeam = new Map<string, number>();
  const picked: Candidate[] = [];
  for (const candidate of ranked) {
    if (picked.length >= MAX_ITEMS) break;
    const used = perTeam.get(candidate.teamId) ?? 0;
    if (used >= MAX_ITEMS_PER_TEAM) continue;
    perTeam.set(candidate.teamId, used + 1);
    picked.push(candidate);
  }
  return picked;
}

function plainItems(picked: Candidate[]): ScoutingItem[] {
  return picked.map(({ teamId, teamName, story }) => ({
    teamId,
    teamName,
    storyId: story.id,
    headline: story.headline,
    text: firstSentence(story.summary || story.headline, MAX_ITEM_CHARS),
    url: story.url,
  }));
}

export interface ScoutingDeps {
  now: () => number;
}

export async function buildScoutingReport(env: Env, teamIds: string[], slot: Slot, sinceMs: number | null, deps: ScoutingDeps): Promise<ScoutingResult> {
  const now = deps.now();
  const since = clampSince(sinceMs, now);
  const names = new Map(TEAMS.map((team) => [team.id, team.name]));

  const candidates: Candidate[] = [];
  for (const teamId of teamIds) {
    const cached = await readTeam(env, teamId, now);
    for (const story of cached?.stories ?? []) {
      const publishedAt = Date.parse(story.publishedAt);
      if (!(publishedAt > since) || publishedAt > now + 3_600_000) continue;
      const ageHours = Math.max(0, (now - publishedAt) / 3_600_000);
      candidates.push({ teamId, teamName: names.get(teamId) ?? teamId, story, score: Math.min(story.sources.length, 4) * 3 + Math.max(0, 4 - ageHours / 12) });
    }
  }
  if (candidates.length === 0) return { status: 'skip', reason: 'nothing-new' };

  const picked = pickCandidates(candidates);
  const id = `${slot}-${hash(`${slot}|${picked.map((candidate) => candidate.story.id).sort().join(',')}`)}`;
  const report: ScoutingReport = {
    id,
    slot,
    title: SLOT_TITLES[slot],
    teaser: firstSentence(picked[0].story.headline, MAX_TEASER_CHARS),
    items: plainItems(picked),
    generatedAt: new Date(now).toISOString(),
    teams: Array.from(new Set(picked.map((candidate) => candidate.teamId))),
  };
  return { status: 'ready', report };
}
