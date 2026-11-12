/**
 * Purpose: the Rival Facts read endpoint (FV2-234): the checked, playful facts for a team, for the app.
 * Owns: GET /v1/rival-facts?team=nfl-lions (or ?teams=a,b, at most 12) -> { teams: { <id>: { status, facts } } }, exact-origin CORS.
 *   status: `ready` (facts stored) or `not-covered`. A store that cannot be read answers `pending` and is not cached.
 *   GET /v1/health -> { ok: true }.
 * Notes: Its own Worker and its own KV item (`rivalfacts:<league>`), read only. It never reads the news stories and nothing
 *   here writes to KV. The facts are written by hand into data/rivalfacts/<league>.json and published by `npm run rivalfacts`, not by the
 *   hourly job. Public and unauthenticated, so it fails closed: the league comes from the team id's prefix and only known leagues are read.
 */
import { parseRivalFacts, rivalFactsKey, type PublicRivalFact } from '../../../src/shared/rivalfacts';

export interface KvReader {
  get(key: string): Promise<string | null>;
}

export interface Env {
  RIVAL_FACTS_KV: KvReader;
  ALLOWED_ORIGIN?: string;
}

const LEAGUES = ['nfl'];
const MAX_TEAMS = 12;
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fly-frontend-1ps\.pages\.dev$/;

const allowedOrigins = (env: Env): string[] => (env.ALLOWED_ORIGIN ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin') ?? '';
  const headers: Record<string, string> = { vary: 'Origin' };
  if (allowedOrigins(env).includes(origin) || PREVIEW_ORIGIN.test(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'GET, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
    headers['access-control-max-age'] = '600';
  }
  return headers;
}

function json(request: Request, env: Env, body: unknown, status = 200, cache = 'public, max-age=300'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': status === 200 ? cache : 'no-store', ...corsHeaders(request, env) } });
}

const leagueOf = (teamId: string): string => teamId.split('-')[0];

type TeamAnswer = { status: 'ready'; facts: PublicRivalFact[] } | { status: 'not-covered' } | { status: 'pending' };

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (request.method !== 'GET') return json(request, env, { error: 'method not allowed' }, 405);
  if (url.pathname === '/v1/health') return json(request, env, { ok: true });
  if (url.pathname !== '/v1/rival-facts') return json(request, env, { error: 'not found' }, 404);
  const ids = [...new Set((url.searchParams.get('teams') ?? url.searchParams.get('team') ?? '').split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_TEAMS) return json(request, env, { error: `ask for 1 to ${MAX_TEAMS} teams` }, 400);

  const stored = new Map<string, ReturnType<typeof parseRivalFacts> | 'failed'>();
  let allCacheable = true;
  for (const league of new Set(ids.map(leagueOf).filter((name) => LEAGUES.includes(name)))) {
    try {
      stored.set(league, parseRivalFacts(await env.RIVAL_FACTS_KV.get(rivalFactsKey(league))));
    } catch {
      stored.set(league, 'failed');
      allCacheable = false;
    }
  }
  const teams: Record<string, TeamAnswer> = {};
  for (const id of ids) {
    const league = leagueOf(id);
    if (!LEAGUES.includes(league)) {
      teams[id] = { status: 'not-covered' };
      continue;
    }
    const payload = stored.get(league);
    if (payload === 'failed') teams[id] = { status: 'pending' };
    else if (payload && payload.teams[id]) teams[id] = { status: 'ready', facts: payload.teams[id] };
    else teams[id] = { status: payload ? 'not-covered' : 'pending' };
    if (teams[id].status === 'pending') allCacheable = false;
  }
  return json(request, env, { teams }, 200, allCacheable ? 'public, max-age=300' : 'no-store');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      return json(request, env, { error: 'unexpected' }, 500);
    }
  },
};
