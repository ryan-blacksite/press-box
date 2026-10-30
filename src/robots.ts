/**
 * Purpose: respect robots.txt (RFC 9309) for every page the writer reads from someone else's site.
 * Owns: parseRobots(), robotsAllows(), createRobotsFetcher() and RobotsBlockedError.
 * Notes: Wrap ONLY the fetcher used for feeds and articles (main.ts), never the AI or store calls, which are APIs we log in to, not
 *   sites we read. Rules for our own name ("PressBox") win over "*". Longest matching rule wins, Allow wins a tie. A robots.txt that
 *   answers 4xx means "no rules"; a 5xx or a network failure means "assume disallowed" (RFC 9309 2.3.1.4), so a site that is down is not
 *   hammered. One robots.txt fetch per host per run. A blocked URL throws RobotsBlockedError, which the feed code already reports as
 *   that source failing, so the run carries on with the sources that allow us.
 */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const ROBOTS_AGENT = 'pressbox';

export class RobotsBlockedError extends Error {}

interface Rule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

function toRegExp(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** The rules that apply to us in a robots.txt body: our own group if there is one, else the "*" group. */
export function parseRobots(body: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (key !== 'allow' && key !== 'disallow')) continue;
    if (value === '') continue; // "Disallow:" with nothing disallows nothing
    current.rules.push({ allow: key === 'allow', pattern: toRegExp(value), length: value.length });
  }
  const own = groups.filter((group) => group.agents.some((agent) => agent !== '*' && ROBOTS_AGENT.includes(agent)));
  const chosen = own.length > 0 ? own : groups.filter((group) => group.agents.includes('*'));
  return chosen.flatMap((group) => group.rules);
}

export function robotsAllows(rules: Rule[], pathAndQuery: string): boolean {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!rule.pattern.test(pathAndQuery)) continue;
    if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/** A fetcher that checks the host's robots.txt before each GET. `rawFetcher` is used for robots.txt itself. */
export function createRobotsFetcher(rawFetcher: Fetcher, userAgent: string): Fetcher {
  const cache = new Map<string, Promise<Rule[] | 'deny-all'>>();

  const load = (origin: string): Promise<Rule[] | 'deny-all'> => {
    let pending = cache.get(origin);
    if (!pending) {
      pending = (async () => {
        try {
          const res = await rawFetcher(`${origin}/robots.txt`, { headers: { 'user-agent': userAgent }, redirect: 'follow', signal: AbortSignal.timeout(8_000) });
          if (res.status >= 500) return 'deny-all';
          if (!res.ok) return [];
          return parseRobots(await res.text());
        } catch {
          return 'deny-all';
        }
      })();
      cache.set(origin, pending);
    }
    return pending;
  };

  return async (url, init) => {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol) || target.pathname === '/robots.txt') return rawFetcher(url, init);
    const rules = await load(target.origin);
    if (rules === 'deny-all' || !robotsAllows(rules, `${target.pathname}${target.search}`)) {
      throw new RobotsBlockedError(`robots.txt on ${target.host} does not allow ${target.pathname}`);
    }
    return rawFetcher(url, init);
  };
}
