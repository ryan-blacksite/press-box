import { describe, expect, it } from 'vitest';
import { buildNflFiles, NFLVERSE_CREDIT, parseCsv } from '../src/nfl/build';

const PLAYER_HEADER = 'player_id,player_name,player_display_name,position,headshot_url,season,week,season_type,game_id,team,opponent_team,completions,attempts,passing_yards,passing_tds,passing_interceptions,carries,rushing_yards,rushing_tds,receptions,targets,receiving_yards,receiving_tds,def_tackles_solo,def_tackle_assists,def_sacks,def_interceptions,fg_att,fg_made,pat_att,pat_made,fg_made_list';
const PLAYER_CSV = [
  PLAYER_HEADER,
  '00-1,J.Love,Jordan Love,QB,https://img.test/a.png,2026,8,REG,2026_08_CAR_GB,GB,CAR,30,41,288,3,1,2,5,0,0,0,0,0,0,0,0,0,0,0,0,0,',
  '00-2,J.Jacobs,Josh Jacobs,RB,https://img.test/b.png,2026,8,REG,2026_08_CAR_GB,GB,CAR,0,0,0,0,0,20,95,1,3,4,20,0,0,0,0,0,0,0,0,0,',
  '00-3,Q.Walker,Quay Walker,LB,,2026,8,REG,2026_08_CAR_GB,GB,CAR,0,0,0,0,0,0,0,0,0,0,0,0,7,2,1,0,0,0,0,0,',
  '00-4,B.Young,Bryce Young,QB,,2026,8,REG,2026_08_CAR_GB,CAR,GB,22,35,201,1,0,3,12,0,0,0,0,0,0,0,0,0,0,0,0,0,"12;34"',
  '00-1,J.Love,Jordan Love,QB,,2026,7,REG,2026_07_GB_X,GB,X,20,30,250,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,',
].join('\n');
const SCHEDULE_CSV = [
  'game_id,season,game_type,week,away_team,away_score,home_team,home_score',
  '2026_08_CAR_GB,2026,REG,8,CAR,19,GB,27',
  '2026_07_X_GB,2026,REG,7,X,10,GB,10',
  '2026_09_GB_BUF,2026,REG,9,GB,,BUF,',
].join('\n');

const built = buildNflFiles(parseCsv(PLAYER_CSV), parseCsv(SCHEDULE_CSV), 2026, new Date('2026-10-30T12:00:00Z'));

describe('nflverse CSV', () => {
  it('reads quoted fields and keeps empty cells', () => {
    const rows = parseCsv('a,b,c\n1,"x, ""y""",\n2,z,w\n');
    expect(rows).toEqual([{ a: '1', b: 'x, "y"', c: '' }, { a: '2', b: 'z', c: 'w' }]);
  });
});

describe('per-game files', () => {
  const game = JSON.parse(built.files.get('nfl/2026/games/2026_08_CAR_GB.json') ?? 'null');

  it('has each team’s players grouped by what they did, best first, with no one in a group they did nothing in', () => {
    expect(Object.keys(game.teams).sort()).toEqual(['CAR', 'GB']);
    expect(game.teams.GB.passing.map((p: { name: string }) => p.name)).toEqual(['Jordan Love']);
    expect(game.teams.GB.passing[0].stats).toMatchObject({ completions: 30, attempts: 41, yards: 288, tds: 3, ints: 1 });
    expect(game.teams.GB.rushing.map((p: { name: string }) => p.name)).toEqual(['Josh Jacobs', 'Jordan Love']);
    expect(game.teams.GB.receiving[0].stats).toMatchObject({ receptions: 3, targets: 4, yards: 20 });
    expect(game.teams.GB.defense[0]).toMatchObject({ name: 'Quay Walker', stats: { soloTackles: 7, assistedTackles: 2, sacks: 1 } });
    expect(game.teams.GB.kicking).toEqual([]);
    expect(game.teams.CAR.passing[0].name).toBe('Bryce Young');
  });

  it('carries the nflverse credit, the licence link and what was changed, and copies no images', () => {
    expect(game.credit).toEqual(NFLVERSE_CREDIT);
    expect(game.credit.license).toBe('CC BY 4.0');
    expect(game.credit.licenseUrl).toContain('creativecommons.org');
    expect(game.credit.changes).toMatch(/not altered/);
    expect(built.files.get('nfl/2026/games/2026_08_CAR_GB.json')).not.toMatch(/img\.test|headshot/);
  });
});

describe('per-team files', () => {
  const team = JSON.parse(built.files.get('nfl/2026/teams/GB.json') ?? 'null');

  it('adds up the season: leaders, team totals, record and points from the schedule (unplayed games ignored)', () => {
    expect(team.leaders.passingYards[0]).toMatchObject({ name: 'Jordan Love', value: 538, games: 2 });
    expect(team.leaders.rushingYards[0]).toMatchObject({ name: 'Josh Jacobs', value: 95 });
    expect(team.leaders.sacks[0]).toMatchObject({ name: 'Quay Walker', value: 1 });
    expect(team.leaders.interceptions).toEqual([]);
    expect(team.teamStats).toMatchObject({ passingYards: 538, passingTds: 5, rushingYards: 100 });
    expect(team.record).toEqual({ wins: 1, losses: 0, ties: 1 });
    expect(team.pointsFor).toBe(37);
    expect(team.pointsAgainst).toBe(29);
    expect(team.games.map((g: { week: number; result: string }) => `${g.week}${g.result}`)).toEqual(['7T', '8W']);
    expect(team.credit.source).toBe('nflverse');
  });
});

describe('the site', () => {
  it('lists every scheduled game with whether stats are posted yet, and carries an attribution page', () => {
    const index = JSON.parse(built.files.get('nfl/2026/index.json') ?? 'null');
    expect(index.updatedAt).toBe('2026-10-30T12:00:00.000Z');
    expect(index.games.find((g: { gameId: string }) => g.gameId === '2026_08_CAR_GB')).toMatchObject({ hasStats: true, awayScore: 19, homeScore: 27 });
    expect(index.games.find((g: { gameId: string }) => g.gameId === '2026_09_GB_BUF')).toMatchObject({ hasStats: false, awayScore: null });
    expect(built.files.get('nfl/ATTRIBUTION.txt')).toContain('CC BY 4.0');
    expect(built.games).toBe(2);
  });
});
