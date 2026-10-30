/**
 * Purpose: turn nflverse's season-wide player-stats file into small per-game and per-team JSON files an app can load on a phone.
 * Owns: parseCsv(), buildNflFiles() and the credit block every file carries.
 * Notes: Data is nflverse (https://github.com/nflverse/nflverse-data), CC BY 4.0, commercial use allowed with credit. Every file carries
 *   the credit, the licence link and a note of what we changed. We only select columns, group them per game or per team, add up season
 *   totals and rank leaders; no value is altered. Facts only: no headshots, logos or team art are copied. Pure functions, no network:
 *   fetch.ts/main.ts do the downloading so this stays testable.
 */

export const NFLVERSE_CREDIT = {
  source: 'nflverse',
  sourceUrl: 'https://github.com/nflverse/nflverse-data',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  changes: 'Selected columns from the nflverse weekly player stats, grouped per game or per team, with season totals added up and leaders ranked. Values are not altered.',
  note: 'nflverse updates after games (usually by the next morning US time), not live.',
} as const;

type Row = Record<string, string>;

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.filter((cells) => cells.length > 1).map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
}

const num = (row: Row, key: string): number => {
  const n = Number(row[key]);
  return Number.isFinite(n) ? n : 0;
};

const pick = (row: Row, keys: Record<string, string>): Record<string, number> =>
  Object.fromEntries(Object.entries(keys).map(([out, column]) => [out, num(row, column)]));

const PASSING = { completions: 'completions', attempts: 'attempts', yards: 'passing_yards', tds: 'passing_tds', ints: 'passing_interceptions', sacked: 'sacks_suffered', sackYardsLost: 'sack_yards_lost' };
const RUSHING = { carries: 'carries', yards: 'rushing_yards', tds: 'rushing_tds', fumblesLost: 'rushing_fumbles_lost' };
const RECEIVING = { receptions: 'receptions', targets: 'targets', yards: 'receiving_yards', tds: 'receiving_tds' };
const DEFENSE = { soloTackles: 'def_tackles_solo', assistedTackles: 'def_tackle_assists', tacklesForLoss: 'def_tackles_for_loss', sacks: 'def_sacks', ints: 'def_interceptions', passesDefended: 'def_pass_defended', forcedFumbles: 'def_fumbles_forced', tds: 'def_tds' };
const KICKING = { fgMade: 'fg_made', fgAtt: 'fg_att', fgLong: 'fg_long', xpMade: 'pat_made', xpAtt: 'pat_att' };

export interface PlayerLine {
  id: string;
  name: string;
  pos: string;
  stats: Record<string, number>;
}

export interface GameTeamStats {
  team: string;
  opponent: string;
  passing: PlayerLine[];
  rushing: PlayerLine[];
  receiving: PlayerLine[];
  defense: PlayerLine[];
  kicking: PlayerLine[];
}

export interface GameFile {
  gameId: string;
  season: number;
  week: number;
  seasonType: string;
  teams: Record<string, GameTeamStats>;
  credit: typeof NFLVERSE_CREDIT;
}

const line = (row: Row, keys: Record<string, string>): PlayerLine => ({
  id: row.player_id,
  name: row.player_display_name || row.player_name,
  pos: row.position,
  stats: pick(row, keys),
});

const byBest = (field: string) => (a: PlayerLine, b: PlayerLine) => (b.stats[field] ?? 0) - (a.stats[field] ?? 0);

function buildGame(gameId: string, rows: Row[]): GameFile {
  const teams: Record<string, GameTeamStats> = {};
  for (const row of rows) {
    const team = (teams[row.team] ??= { team: row.team, opponent: row.opponent_team, passing: [], rushing: [], receiving: [], defense: [], kicking: [] });
    if (num(row, 'attempts') > 0) team.passing.push(line(row, PASSING));
    if (num(row, 'carries') > 0) team.rushing.push(line(row, RUSHING));
    if (num(row, 'targets') > 0 || num(row, 'receptions') > 0) team.receiving.push(line(row, RECEIVING));
    if (Object.values(DEFENSE).some((column) => num(row, column) > 0)) team.defense.push(line(row, DEFENSE));
    if (num(row, 'fg_att') > 0 || num(row, 'pat_att') > 0) team.kicking.push(line(row, KICKING));
  }
  for (const team of Object.values(teams)) {
    team.passing.sort(byBest('yards'));
    team.rushing.sort(byBest('yards'));
    team.receiving.sort(byBest('yards'));
    team.defense.sort((a, b) => (b.stats.soloTackles + b.stats.assistedTackles) - (a.stats.soloTackles + a.stats.assistedTackles));
    team.kicking.sort(byBest('fgMade'));
  }
  const first = rows[0];
  return { gameId, season: num(first, 'season'), week: num(first, 'week'), seasonType: first.season_type, teams, credit: NFLVERSE_CREDIT };
}

export interface Leader {
  id: string;
  name: string;
  pos: string;
  value: number;
  games: number;
}

export interface TeamFile {
  team: string;
  season: number;
  gamesPlayed: number;
  record: { wins: number; losses: number; ties: number };
  pointsFor: number;
  pointsAgainst: number;
  teamStats: Record<string, number>;
  leaders: Record<string, Leader[]>;
  games: { gameId: string; week: number; opponent: string; home: boolean; pointsFor: number; pointsAgainst: number; result: 'W' | 'L' | 'T' }[];
  credit: typeof NFLVERSE_CREDIT;
}

const LEADER_BOARDS: { key: string; column: string; minimum?: { column: string; value: number } }[] = [
  { key: 'passingYards', column: 'passing_yards' },
  { key: 'passingTds', column: 'passing_tds' },
  { key: 'rushingYards', column: 'rushing_yards' },
  { key: 'rushingTds', column: 'rushing_tds' },
  { key: 'receivingYards', column: 'receiving_yards' },
  { key: 'receptions', column: 'receptions' },
  { key: 'receivingTds', column: 'receiving_tds' },
  { key: 'sacks', column: 'def_sacks' },
  { key: 'interceptions', column: 'def_interceptions' },
];

const TEAM_TOTALS: Record<string, string> = {
  passingYards: 'passing_yards', passingTds: 'passing_tds', passingInts: 'passing_interceptions', rushingYards: 'rushing_yards', rushingTds: 'rushing_tds',
  receivingTds: 'receiving_tds', sacksMade: 'def_sacks', interceptionsMade: 'def_interceptions', sacksTaken: 'sacks_suffered',
};

function buildTeam(team: string, season: number, rows: Row[], schedule: Row[]): TeamFile {
  const players = new Map<string, Row[]>();
  for (const row of rows) players.set(row.player_id, [...(players.get(row.player_id) ?? []), row]);

  const leaders: Record<string, Leader[]> = {};
  for (const board of LEADER_BOARDS) {
    leaders[board.key] = [...players.values()]
      .map((list) => ({ id: list[0].player_id, name: list[0].player_display_name || list[0].player_name, pos: list[0].position, value: list.reduce((sum, row) => sum + num(row, board.column), 0), games: list.length }))
      .filter((leader) => leader.value > 0)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
      .slice(0, 5);
  }

  const teamStats = Object.fromEntries(Object.entries(TEAM_TOTALS).map(([key, column]) => [key, Math.round(rows.reduce((sum, row) => sum + num(row, column), 0) * 10) / 10]));

  const games: TeamFile['games'] = [];
  const record = { wins: 0, losses: 0, ties: 0 };
  let pointsFor = 0;
  let pointsAgainst = 0;
  for (const game of schedule) {
    const home = game.home_team === team;
    if (!home && game.away_team !== team) continue;
    if (game.game_type !== 'REG' || game.home_score === '' || game.away_score === '') continue;
    const mine = num(game, home ? 'home_score' : 'away_score');
    const theirs = num(game, home ? 'away_score' : 'home_score');
    const result = mine > theirs ? 'W' : mine < theirs ? 'L' : 'T';
    record[result === 'W' ? 'wins' : result === 'L' ? 'losses' : 'ties'] += 1;
    pointsFor += mine;
    pointsAgainst += theirs;
    games.push({ gameId: game.game_id, week: num(game, 'week'), opponent: home ? game.away_team : game.home_team, home, pointsFor: mine, pointsAgainst: theirs, result });
  }
  games.sort((a, b) => a.week - b.week);
  return { team, season, gamesPlayed: games.length, record, pointsFor, pointsAgainst, teamStats, leaders, games, credit: NFLVERSE_CREDIT };
}

export interface NflFiles {
  /** path under the site root -> JSON text */
  files: Map<string, string>;
  games: number;
  teams: number;
}

/** playerRows = nflverse stats_player_week_<season>.csv; schedule = nflverse games.csv (for scores and records). */
export function buildNflFiles(playerRows: Row[], schedule: Row[], season: number, now: Date): NflFiles {
  const files = new Map<string, string>();
  const regular = playerRows.filter((row) => num(row, 'season') === season);
  const byGame = new Map<string, Row[]>();
  const byTeam = new Map<string, Row[]>();
  for (const row of regular) {
    if (!row.game_id || !row.team) continue;
    byGame.set(row.game_id, [...(byGame.get(row.game_id) ?? []), row]);
    if (row.season_type === 'REG') byTeam.set(row.team, [...(byTeam.get(row.team) ?? []), row]);
  }

  const seasonSchedule = schedule.filter((game) => num(game, 'season') === season);
  const index: { gameId: string; week: number; seasonType: string; date: string; away: string; home: string; awayScore: number | null; homeScore: number | null; hasStats: boolean }[] = [];
  for (const game of seasonSchedule) {
    index.push({
      gameId: game.game_id, week: num(game, 'week'), seasonType: game.game_type, date: game.gameday ?? '', away: game.away_team, home: game.home_team,
      awayScore: game.away_score === '' ? null : num(game, 'away_score'), homeScore: game.home_score === '' ? null : num(game, 'home_score'),
      hasStats: byGame.has(game.game_id),
    });
  }

  for (const [gameId, rows] of byGame) files.set(`nfl/${season}/games/${gameId}.json`, JSON.stringify(buildGame(gameId, rows)));
  for (const [team, rows] of byTeam) files.set(`nfl/${season}/teams/${team}.json`, JSON.stringify(buildTeam(team, season, rows, seasonSchedule)));
  files.set(`nfl/${season}/index.json`, JSON.stringify({ season, updatedAt: now.toISOString(), games: index, credit: NFLVERSE_CREDIT }));
  files.set(
    'nfl/ATTRIBUTION.txt',
    `NFL stats here come from nflverse (${NFLVERSE_CREDIT.sourceUrl}), licensed CC BY 4.0 (${NFLVERSE_CREDIT.licenseUrl}).\n${NFLVERSE_CREDIT.changes}\n${NFLVERSE_CREDIT.note}\n`,
  );
  return { files, games: byGame.size, teams: byTeam.size };
}
