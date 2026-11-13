/**
 * Purpose: publish a league's checked-in rival facts to the store (FV2-234): `npm run rivalfacts -- nfl` (the command line entry is main.ts).
 * Owns: loadRivalFacts() and publishRivalFacts(). Reads data/rivalfacts/<league>.json, refuses anything that does not pass validateRivalFacts(), and writes
 *   ONE KV item, `rivalfacts:<league>`, only when its text changed. It never touches `bundle:*` or any story, and the hourly writer never
 *   runs it: facts go out when a person runs this after the data file changes.
 * Notes: DRY_RUN=1 prints what would be written and writes nothing. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers KV
 *   Storage: Edit) and, optionally, PRESS_BOX_KV_NAMESPACE_ID, like the writer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { KvStore } from '../kv';
import { loadTeams } from '../shared/teams';
import { RIVAL_FACTS_VERSION, rivalFactsKey, serializeRivalFacts, toPublicPayload, validateRivalFacts, type RivalFactsFile } from '../shared/rivalfacts';

export const rivalFactsFile = (league: string): string => fileURLToPath(new URL(`../../data/rivalfacts/${league.toLowerCase()}.json`, import.meta.url));

export function loadRivalFacts(league: string, file: string = rivalFactsFile(league)): RivalFactsFile {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as RivalFactsFile;
  const teamIds = loadTeams().filter((team) => team.league.toLowerCase() === league.toLowerCase()).map((team) => team.id);
  const problems = validateRivalFacts(parsed, teamIds);
  if (parsed?.v !== RIVAL_FACTS_VERSION || problems.length > 0) throw new Error(`${file} is not publishable:\n- ${problems.join('\n- ')}`);
  return parsed;
}

export interface PublishResult {
  key: string;
  wrote: boolean;
  bytes: number;
}

/** Write the facts item if its text differs from what is stored. */
export async function publishRivalFacts(league: string, kv: KvStore | null, options: { dryRun: boolean }, file?: string): Promise<PublishResult> {
  const key = rivalFactsKey(league);
  if (key.startsWith('bundle:')) throw new Error('rival facts never use a story key');
  const text = serializeRivalFacts(toPublicPayload(loadRivalFacts(league, file)));
  if (options.dryRun || !kv) return { key, wrote: false, bytes: text.length };
  if ((await kv.get(key)) === text) return { key, wrote: false, bytes: text.length };
  await kv.put(key, text);
  return { key, wrote: true, bytes: text.length };
}
