/**
 * Purpose: read and write the Press Box store (Cloudflare Workers KV) from the writer job over Cloudflare's REST API (FV2-16).
 * Owns: createKv() (get, put), the KV key names, and the store's time-to-live.
 * Notes: The Worker (workers/press-box) reads the same namespace through its binding, so the key and the JSON value here are
 *   exactly what it reads: bundle:<league> -> a league's teams (workers/press-box/src/bundle.ts; FV2-47, one item per league instead of
 *   one per team). Writes use the bulk endpoint (a JSON array, with
 *   expiration_ttl) and, if Cloudflare refuses that, the single-key multipart endpoint, so a change on Cloudflare's side of one
 *   route does not stop the job. Rate limits (429) and server errors are retried with a growing pause. The API token needs only
 *   "Workers KV Storage: Edit" and lives in GitHub Actions secrets; it is sent as a bearer header and never logged.
 */

export const TEAM_KEY_PREFIX = 'team:';
/** FV2-47: the old per-team items. Nothing writes them any more; they expire after this, and are read once to seed a league's bundle. */
export const TEAM_TTL_S = 14 * 86_400;
export const teamKey = (teamId: string) => `${TEAM_KEY_PREFIX}${teamId}`;

export interface KvSettings {
  accountId: string;
  apiToken: string;
  namespaceId: string;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  /** `ttlSeconds` 0 (or omitted) stores it without an expiry, as the league bundles are (bundles.ts). */
  put(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

export interface KvDeps {
  fetcher: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

const MAX_TRIES = 4;
const API = 'https://api.cloudflare.com/client/v4';

export class KvError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function createKv(settings: KvSettings, deps: KvDeps): KvStore {
  const base = `${API}/accounts/${encodeURIComponent(settings.accountId)}/storage/kv/namespaces/${encodeURIComponent(settings.namespaceId)}`;
  const auth = { authorization: `Bearer ${settings.apiToken}` };

  /** One request with retries on 429 and 5xx. Returns the final response (the caller reads its status). */
  async function send(url: string, init: RequestInit): Promise<Response> {
    let last: Response | null = null;
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      try {
        last = await deps.fetcher(url, init);
      } catch (error) {
        if (attempt === MAX_TRIES - 1) throw new KvError(`Cloudflare could not be reached (${error instanceof Error ? error.name : 'unknown error'})`, 0);
        await deps.sleep(1_000 * 2 ** attempt);
        continue;
      }
      if (last.status !== 429 && last.status < 500) return last;
      const retryAfter = Number(last.headers.get('retry-after'));
      await deps.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1_000 : 1_000 * 2 ** attempt);
    }
    return last as Response;
  }

  return {
    async get(key) {
      const res = await send(`${base}/values/${encodeURIComponent(key)}`, { headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) throw new KvError(`Cloudflare KV read failed (${res.status})`, res.status);
      return res.text();
    },

    async put(key, value, ttlSeconds = 0) {
      const bulk = await send(`${base}/bulk`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify([ttlSeconds > 0 ? { key, value, expiration_ttl: ttlSeconds } : { key, value }]),
      });
      if (bulk.ok) return;
      // A bad token or a rate limit would fail the other route too; anything else gets the single-key route.
      if (bulk.status === 401 || bulk.status === 403 || bulk.status === 429 || bulk.status >= 500) {
        throw new KvError(`Cloudflare KV write failed (${bulk.status})`, bulk.status);
      }
      const form = new FormData();
      form.set('value', value);
      form.set('metadata', '{}');
      const single = await send(`${base}/values/${encodeURIComponent(key)}${ttlSeconds > 0 ? `?expiration_ttl=${ttlSeconds}` : ''}`, { method: 'PUT', headers: auth, body: form });
      if (!single.ok) throw new KvError(`Cloudflare KV write failed (${bulk.status} on bulk, ${single.status} on single)`, single.status);
    },
  };
}
