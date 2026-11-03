/**
 * Purpose: decide which sources Press Box may read and credit, and which pages are not stories (FV2-154 item 6b, 6c).
 * Owns: OUTLETS (the allowlist of real English sports outlets), outletForUrl(), isEnglishText(), isNonStoryTitle(),
 *   isNonStoryUrl(), looksLikeStatsPage(), and trustFor() (the allowlist plus the hosts of the operator's own team-site feeds).
 * Notes: The credit shown on a story is the allowlist's own name for the outlet, taken from the article's real address, never the
 *   free text a feed puts in <source>. That text is how a Dallas Stars story came to credit a Japanese regional government office
 *   next to Daily Faceoff. A page whose host is not on the list is not read, not summarized and not credited. Team and league
 *   sites are trusted through the team-site feed map (config TEAM_SITE_FEEDS) and EXTRA_OUTLETS, so the list is not FLY-specific.
 *   Pure functions: no network, no clock.
 */

/** host (no "www."), matched exactly or as the parent of a subdomain -> the name credited on a story. */
export const OUTLETS: Readonly<Record<string, string>> = {
  'espn.com': 'ESPN',
  'motorsport.com': 'Motorsport.com',
  'espn.co.uk': 'ESPN',
  'nhl.com': 'NHL.com',
  'nfl.com': 'NFL.com',
  'nba.com': 'NBA.com',
  'mlb.com': 'MLB.com',
  'mlssoccer.com': 'MLSsoccer.com',
  'premierleague.com': 'Premier League',
  'ncaa.com': 'NCAA.com',
  'cbssports.com': 'CBS Sports',
  'sports.yahoo.com': 'Yahoo Sports',
  'apnews.com': 'The Associated Press',
  'dailyfaceoff.com': 'Daily Faceoff',
  'foxsports.com': 'FOX Sports',
  'nbcsports.com': 'NBC Sports',
  'si.com': 'Sports Illustrated',
  'usatoday.com': 'USA TODAY',
  'bleacherreport.com': 'Bleacher Report',
  'sportingnews.com': 'Sporting News',
  'theathletic.com': 'The Athletic',
  'nytimes.com': 'The New York Times',
  'sportsnet.ca': 'Sportsnet',
  'tsn.ca': 'TSN',
  'thescore.com': 'theScore',
  'profootballtalk.com': 'Pro Football Talk',
  'rotowire.com': 'RotoWire',
  'fanragsports.com': 'FanRag Sports',
  'bbc.com': 'BBC Sport',
  'bbc.co.uk': 'BBC Sport',
  'skysports.com': 'Sky Sports',
  'theguardian.com': 'The Guardian',
};

const SCRIPT_OUTSIDE_LATIN = /[^\u0000-ɏ -⁯₠-⃏]/;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** The allowlist (plus any extra host -> name pairs) matched against an address. Null when the host is not a trusted sports outlet. */
export function outletForUrl(url: string, extra: Readonly<Record<string, string>> = {}): string | null {
  const host = hostOf(url);
  if (!host) return null;
  const table = { ...OUTLETS, ...extra };
  const match = Object.keys(table).find((domain) => host === domain || host.endsWith(`.${domain}`));
  return match ? table[match] : null;
}

/**
 * Plain English text: Latin letters only, and enough common English words. A Japanese, Spanish or Russian page, or a mix, fails.
 * Short strings (a headline of a few words) are judged on script alone.
 */
export function isEnglishText(text: string): boolean {
  if (SCRIPT_OUTSIDE_LATIN.test(text)) return false;
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length < 40) return true;
  const common = new Set(['the', 'and', 'to', 'of', 'a', 'in', 'is', 'for', 'on', 'that', 'with', 'was', 'he', 'his', 'as', 'at', 'it', 'by', 'said', 'will']);
  return words.filter((word) => common.has(word)).length / words.length >= 0.12;
}

/** Pages that are tables or tools, not news: "Dallas Stars Line Combinations", "Depth Chart", "Stats", "Standings", "Schedule". */
const NON_STORY_TITLE = /\b(line ?combinations?|lines? and pairings|depth ?chart|power play units?|(player|team|season|game|career)? ?stats?|stats? (leaders|page|tracker)|standings|schedule( and results)?|scoreboard|box ?score|game ?log|odds|betting lines?|tickets|roster( and depth chart)?|fantasy (rankings|cheat ?sheet)|salary cap (page|tracker)|cap ?friendly|transactions? (log|tracker))\s*(\||-|–|—|:|$)/i;

/**
 * Things that are about the game but are not news of it: betting guides and picks, predictions, power rankings, trackers, how-to-watch
 * guides, uniform roundups, polls, trivia lists, fantasy advice, video highlights, galleries and link roundups.
 */
const NON_STORY_KIND = /\b(betting|odds|point spread|against the spread|ats picks|prop bets?|parlays?|best bets?|expert picks|picks? (and|&) predictions?|predictions?|power rankings?|weekly rankings|tracker|uniforms?|highlights|polls?|poll results|fan vote|mock draft|how to watch|where to watch|what to watch|everything you need to know|draft order|projections?|game previews?|live ?stream|what channel|tv channel|start time|cheat ?sheet|fantasy|dfs|trivia|quiz|photos|gallery|links|roundup|round-up|mailbag|open thread|game ?thread)\b|\bwho (has|have) won\b|\bwho won the most\b|\bschedule,/i;

export function isNonStoryTitle(title: string): boolean {
  return NON_STORY_TITLE.test(title.trim()) || /\bline ?combinations?\b/i.test(title) || NON_STORY_KIND.test(title);
}

const NON_STORY_PATH = /\/(line-?combinations?|lines|depth-?chart|stats?|standings|schedule|scoreboard|boxscore|gamelog|odds|betting|picks|predictions|tickets|roster|rosters|players?|teams?|cap-?space|salary-?cap|preview|video|videos|watch|gallery|galleries|photos|podcasts?|fantasy)\/?(\?|#|$)|\/(video|videos|gallery|photos|betting|odds|fantasy)\//i;

export function isNonStoryUrl(url: string): boolean {
  try {
    return NON_STORY_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** A page that is mostly numbers and short cells (a stat table) rather than sentences. */
export function looksLikeStatsPage(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const digits = (text.match(/\d/g) ?? []).length;
  const sentences = (text.match(/[A-Za-z][^.!?]{25,}[.!?](\s|$)/g) ?? []).length;
  return sentences < 3 || digits > letters * 0.25;
}

export interface Trust {
  /** The credited outlet name for an address, or null if the host is not trusted. */
  outlet(url: string): string | null;
}

/** The allowlist plus the hosts of the operator's team-site feeds (trusted by being configured) and EXTRA_OUTLETS ("host=Name,host=Name"). */
export function trustFor(teamSiteFeeds: Record<string, string> | undefined, extraOutlets = ''): Trust {
  const extra: Record<string, string> = {};
  for (const url of Object.values(teamSiteFeeds ?? {})) {
    const host = hostOf(url);
    // A host the built-in list already names keeps its proper name (nhl.com stays "NHL.com").
    if (host && !(host in extra) && !outletForUrl(url)) extra[host] = host;
  }
  for (const pair of extraOutlets.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const [host, name] = pair.split('=').map((part) => part.trim());
    if (host && name) extra[host.toLowerCase().replace(/^www\./, '')] = name;
  }
  return { outlet: (url) => outletForUrl(url, extra) };
}
