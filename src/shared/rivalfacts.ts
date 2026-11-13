/**
 * Purpose: the "rival facts" store: short, playful, TRUE facts about a team for an app feature that is not public yet (FV2-234).
 * Owns: rivalFactsKey(), the checked-in file shape (RivalFactsFile), validateRivalFacts(), the public payload (toPublicPayload,
 *   parseRivalFacts) and looksLikeRivalFact().
 * Notes: Facts are NOT news. They are written once by people (and kept in data/rivalfacts/<league>.json, which we keep adding to), never
 *   by the hourly free-model job, and they live in their own KV item `rivalfacts:<league>`, read through their own Worker
 *   (workers/rival-facts). They never go into a story bundle (`bundle:<league>`, bundle.ts): the writer's bundle code does not import this
 *   file, and test/rivalfacts.test.ts fails if a fact ever turns up in a bundle. Every fact carries the page that proves it; the file also
 *   keeps the claim, a short proof snippet and the date checked, and the public payload drops those and keeps only text + source.
 *   Not announced yet: keep this out of public docs.
 */

export const RIVAL_FACTS_VERSION = 1;
export const FACT_PREFIX = 'Fun fact. ';
export const RIVAL_FACTS_PER_TEAM = 5;

export const rivalFactsKey = (league: string): string => `rivalfacts:${league.toLowerCase()}`;

/** One fact as it is checked in (data/rivalfacts/<league>.json). */
export interface RivalFactEntry {
  /** What a fan reads. Starts with "Fun fact. ". */
  text: string;
  sourceName: string;
  /** The page that proves it (https). */
  sourceUrl: string;
  /** The one-line plain statement that was verified (with the arithmetic when there is any). */
  claim: string;
  /** A short snippet seen on the source page that supports the claim. */
  proof: string;
  /** The data is true through this point (e.g. "2025 season"). */
  asOf: string;
  /** YYYY-MM-DD the source was last opened and the fact confirmed. */
  checkedOn: string;
}

export interface RivalFactsFile {
  v: number;
  league: string;
  teams: Record<string, RivalFactEntry[]>;
}

/** What the Worker serves for one fact. */
export interface PublicRivalFact {
  text: string;
  source: { name: string; url: string };
}

export interface RivalFactsPayload {
  v: number;
  league: string;
  teams: Record<string, PublicRivalFact[]>;
}

/** True for text written in the rival-fact voice. Used to keep facts out of the news stories. */
export function looksLikeRivalFact(text: unknown): boolean {
  return typeof text === 'string' && text.trimStart().startsWith('Fun fact.');
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Every problem with a facts file (empty list = fine). `teamIds` is the league's team ids: exactly those, each with `perTeam` facts. */
export function validateRivalFacts(file: unknown, teamIds: readonly string[], perTeam: number = RIVAL_FACTS_PER_TEAM): string[] {
  const problems: string[] = [];
  if (!file || typeof file !== 'object') return ['the file is not an object'];
  const parsed = file as Partial<RivalFactsFile>;
  if (parsed.v !== RIVAL_FACTS_VERSION) problems.push(`v must be ${RIVAL_FACTS_VERSION}`);
  if (!isText(parsed.league)) problems.push('league is missing');
  const teams = parsed.teams && typeof parsed.teams === 'object' ? parsed.teams : null;
  if (!teams) return [...problems, 'teams is missing'];
  for (const id of teamIds) if (!(id in teams)) problems.push(`${id}: no facts`);
  const seenText = new Set<string>();
  for (const [id, facts] of Object.entries(teams)) {
    if (!teamIds.includes(id)) problems.push(`${id}: not a team of this league`);
    if (!Array.isArray(facts)) {
      problems.push(`${id}: facts must be a list`);
      continue;
    }
    if (facts.length !== perTeam) problems.push(`${id}: ${facts.length} facts, needs ${perTeam}`);
    facts.forEach((fact, index) => {
      const where = `${id}[${index}]`;
      if (!fact || typeof fact !== 'object') return void problems.push(`${where}: not an object`);
      const entry = fact as Partial<RivalFactEntry>;
      if (!isText(entry.text) || !entry.text.startsWith(FACT_PREFIX)) problems.push(`${where}: text must start with "${FACT_PREFIX}"`);
      else if (entry.text.length > 200) problems.push(`${where}: text is longer than 200 characters`);
      if (isText(entry.text)) {
        if (seenText.has(entry.text)) problems.push(`${where}: the same fact appears twice`);
        seenText.add(entry.text);
      }
      for (const field of ['sourceName', 'claim', 'proof', 'asOf'] as const) if (!isText(entry[field])) problems.push(`${where}: ${field} is missing`);
      if (!isText(entry.sourceUrl) || !/^https:\/\/[^\s/]+\.[^\s/]+\/\S*$/.test(entry.sourceUrl)) problems.push(`${where}: sourceUrl must be an https page address`);
      if (!isText(entry.checkedOn) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.checkedOn)) problems.push(`${where}: checkedOn must be YYYY-MM-DD`);
    });
  }
  return problems;
}

/** The public payload for the Worker: text and source only (the proof stays in the repo). Canonical: teams sorted. */
export function toPublicPayload(file: RivalFactsFile): RivalFactsPayload {
  const teams: Record<string, PublicRivalFact[]> = {};
  for (const id of Object.keys(file.teams).sort()) {
    teams[id] = file.teams[id].map((fact) => ({ text: fact.text, source: { name: fact.sourceName, url: fact.sourceUrl } }));
  }
  return { v: RIVAL_FACTS_VERSION, league: file.league.toLowerCase(), teams };
}

export const serializeRivalFacts = (payload: RivalFactsPayload): string => JSON.stringify(payload);

/** A stored payload as the Worker reads it, or null when it is missing or not a facts payload. Never throws; odd entries are dropped. */
export function parseRivalFacts(raw: string | null): RivalFactsPayload | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const stored = value as Record<string, unknown>;
  if (stored.v !== RIVAL_FACTS_VERSION || typeof stored.league !== 'string' || !stored.teams || typeof stored.teams !== 'object' || Array.isArray(stored.teams)) return null;
  const teams: Record<string, PublicRivalFact[]> = Object.create(null);
  for (const [id, list] of Object.entries(stored.teams as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const facts: PublicRivalFact[] = [];
    for (const item of list) {
      const fact = item as { text?: unknown; source?: { name?: unknown; url?: unknown } } | null;
      if (fact && isText(fact.text) && fact.source && isText(fact.source.name) && isText(fact.source.url) && fact.source.url.startsWith('https://')) {
        facts.push({ text: fact.text, source: { name: fact.source.name, url: fact.source.url } });
      }
    }
    if (facts.length > 0) teams[id] = facts;
  }
  return { v: RIVAL_FACTS_VERSION, league: stored.league, teams };
}
