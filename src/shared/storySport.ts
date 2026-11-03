/**
 * Purpose: stop a team's Press Box from accepting an article about another sport or a women's program.
 * Owns: sportForLeague(), isStoryForTeamSport(), and filterStoriesForTeam() for writer and Worker use.
 * Notes: News search and an AI prompt are not guarantees; this deterministic check protects both new and stored stories.
 */
import type { PressBoxTeam } from './teams';

export interface StoryTopic {
  headline: string;
  summary: string;
}

const sportTerms: Record<string, RegExp> = {
  football: /\b(?:football|quarterback|\bqbs?\b|gridiron|touchdowns?|field goals?|running backs?|wide receivers?|offensive line|defensive line|nfl draft|college football|cfp|bowl game)\b/i,
  basketball: /\b(?:basketball|hoops|\bwnba\b|\bnba\b|\bncaa tournament\b|march madness|point guard|shooting guard|three.pointer|slam dunk|free throws?|rebound|crossover)\b/i,
  baseball: /\b(?:baseball|softball|\bmlb\b|home runs?|pitchers?|pitching|bullpen|innings?|batting|grand slam|strikeouts?|world series)\b/i,
  hockey: /\b(?:hockey|\bnhl\b|ice rink|puck|goalie|goaltender|power play|faceoff|stanley cup)\b/i,
  soccer: /\b(?:soccer|\bmls\b|\bnwsl\b|premier league|fifa|world cup|goalkeeper|penalty kick|transfer window|midfielder|striker)\b/i,
  volleyball: /\b(?:volleyball|setter|libero|spike|serve receive)\b/i,
  track: /\b(?:track and field|track & field|cross.country|distance runner|sprinter|hurdles|pole vault|shot put|discus)\b/i,
  tennis: /\b(?:tennis|atp tour|wta tour|grand slam|serve and volley)\b/i,
  golf: /\b(?:golf|pga tour|lpga|putting|birdie|eagle|ryder cup)\b/i,
  lacrosse: /\b(?:lacrosse|face.off|goalie|stick skills)\b/i,
  swimming: /\b(?:swimming|swim meet|freestyle|backstroke|breaststroke|butterfly|relay team)\b/i,
  wrestling: /\b(?:wrestling|\bncaa wrestling\b|pinfall|takedown|mat)\b/i,
  gymnastics: /\b(?:gymnastics|balance beam|uneven bars|floor exercise|vault routine)\b/i,
  rowing: /\b(?:rowing|crew team|regatta|eight boat)\b/i,
};

const leagueSport: Record<string, string> = {
  NFL: 'football', NCAAF: 'football',
  NBA: 'basketball', NCAAMB: 'basketball',
  MLB: 'baseball', NHL: 'hockey', MLS: 'soccer', EPL: 'soccer', FIFA: 'soccer',
};

export function sportForLeague(league: string): string | null {
  return leagueSport[league] ?? null;
}

function hasWomensProgram(text: string): boolean {
  return /\b(?:women(?:'|’)?s|lady|ladies|\bwbb\b|\bnwsl\b)\b/i.test(text);
}

/** Returns false only when text gives clear evidence that the story belongs to another sport/side. */
export function isStoryForTeamSport(story: StoryTopic, team: Pick<PressBoxTeam, 'league'>): boolean {
  const expected = sportForLeague(team.league);
  if (!expected) return true;
  const text = `${story.headline} ${story.summary}`;
  if (hasWomensProgram(text)) return false;
  const expectedTerms = sportTerms[expected];
  const conflictingHeadline = Object.entries(sportTerms).some(([sport, pattern]) => sport !== expected && pattern.test(story.headline));
  if (conflictingHeadline && !expectedTerms.test(story.headline)) return false;
  if ((team.league === 'NCAAF' || team.league === 'NCAAMB') && !expectedTerms.test(text)) return false;
  const otherSportMentioned = Object.entries(sportTerms).some(([sport, pattern]) => sport !== expected && pattern.test(text));
  return !(otherSportMentioned && !expectedTerms.test(text));
}

export function filterStoriesForTeam<T extends StoryTopic>(stories: T[], team: Pick<PressBoxTeam, 'league'>): T[] {
  return stories.filter((story) => isStoryForTeamSport(story, team));
}
