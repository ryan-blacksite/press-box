/**
 * Purpose: the teams this writer covers. They come from a JSON file (config/teams.fly.json by default, or TEAMS_FILE), never from code,
 *   so another app brings its own list.
 * Owns: PressBoxTeam and TEAMS.
 * Notes: Each entry is { id, league, name, abbreviation, city }. `id` is the key stories are stored under, so it must match what the
 *   reading app asks for. Leagues the writer knows how to search are in storySport.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface PressBoxTeam {
  id: string;
  league: string;
  name: string;
  abbreviation: string;
  city: string;
}

const defaultFile = fileURLToPath(new URL('../../config/teams.fly.json', import.meta.url));

export function loadTeams(file: string = process.env.TEAMS_FILE || defaultFile): readonly PressBoxTeam[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} must be a JSON list of teams`);
  for (const team of parsed as Partial<PressBoxTeam>[]) {
    if (!team || typeof team.id !== 'string' || typeof team.league !== 'string' || typeof team.name !== 'string') {
      throw new Error(`${file}: every team needs id, league and name (got ${JSON.stringify(team)})`);
    }
  }
  return parsed as PressBoxTeam[];
}

export const TEAMS: readonly PressBoxTeam[] = loadTeams();
