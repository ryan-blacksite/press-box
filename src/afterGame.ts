/**
 * Purpose: which teams had a game go final today (FV2-16), for the after-game refresh.
 * Owns: easternDay(), scoreboardUrl() and finishedTeamIds().
 * Notes: Reads ESPN's public scoreboards (the same site the Press Box already reads team news from; no key, free) for the
 *   current US Eastern day and keeps the covered teams that played a game with a completed status. A league whose scoreboard
 *   cannot be read just has no finished teams this run (they are picked up by the next daily run); it never fails the job.
 *   Teams are matched to the scoreboard by league and abbreviation, as the news feed already does.
 */
import { ESPN_SPORT_PATH } from './feeds';
import type { PressBoxTeam } from './shared/teams';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The US Eastern calendar day as YYYYMMDD (ESPN's `dates` format). */
export function easternDay(now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(now)).replace(/-/g, '');
}

/** College scoreboards list only featured games unless asked for the whole division (FBS = 80, men's D-I basketball = 50). */
const COLLEGE_GROUP: Record<string, string> = { NCAAF: '80', NCAAMB: '50' };

export function scoreboardUrl(league: string, day: string): string | null {
  const path = ESPN_SPORT_PATH[league];
  if (!path) return null;
  const group = COLLEGE_GROUP[league] ? `&groups=${COLLEGE_GROUP[league]}` : '';
  return `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${day}&limit=400${group}`;
}

interface EspnEvent {
  status?: { type?: { completed?: boolean } };
  competitions?: { status?: { type?: { completed?: boolean } }; competitors?: { team?: { abbreviation?: string } }[] }[];
}

/** Abbreviations (upper case) of the teams in completed games on that day's scoreboard. */
export function completedAbbreviations(json: string): Set<string> {
  const out = new Set<string>();
  try {
    const data = JSON.parse(json) as { events?: EspnEvent[] };
    for (const event of data.events ?? []) {
      const competition = event.competitions?.[0];
      const completed = competition?.status?.type?.completed ?? event.status?.type?.completed;
      if (!completed) continue;
      for (const competitor of competition?.competitors ?? []) {
        const abbreviation = competitor.team?.abbreviation;
        if (abbreviation) out.add(abbreviation.toUpperCase());
      }
    }
  } catch {
    // An unreadable scoreboard means no finished teams from it.
  }
  return out;
}

/** The ids of these teams whose game went final on the current Eastern day. */
export async function finishedTeamIds(teams: readonly PressBoxTeam[], fetcher: Fetcher, now: number, onIssue: (message: string) => void = () => undefined): Promise<Set<string>> {
  const day = easternDay(now);
  const leagues = Array.from(new Set(teams.map((team) => team.league)));
  const byLeague = new Map<string, Set<string>>();
  await Promise.all(
    leagues.map(async (league) => {
      const url = scoreboardUrl(league, day);
      if (!url) return;
      try {
        const res = await fetcher(url, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`scoreboard ${res.status}`);
        byLeague.set(league, completedAbbreviations(await res.text()));
      } catch (error) {
        onIssue(`${league} scoreboard failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  return new Set(teams.filter((team) => byLeague.get(team.league)?.has(team.abbreviation.toUpperCase())).map((team) => team.id));
}
