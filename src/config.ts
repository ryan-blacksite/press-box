/**
 * Purpose: the Press Box writer job's settings (FV2-16): which AI endpoint and free models to use, where the store is, and
 *   how hard to push the free limits.
 * Owns: DEFAULT_FREE_MODELS, WriterConfig and loadConfig().
 * Notes: Everything comes from environment variables, so the GitHub Actions workflow sets them from secrets (OPENROUTER_API_KEY,
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) and repository variables, and nothing secret is ever in code. The AI endpoint
 *   is any OpenAI-compatible chat-completions API: AI_BASE_URL (default OpenRouter), AI_API_KEY (falls back to
 *   OPENROUTER_API_KEY) and AI_MODELS (comma list tried in order). Pointing at another provider later is those three
 *   settings and no code. The defaults are OpenRouter's ":free" models, which cost no credits; with credits purchased the free
 *   limit is about 1,000 requests a day and 20 a minute, so one AI call writes several teams' stories (BATCH_TEAMS, default 3), request
 *   starts are paced, several requests run at once (AI_CONCURRENCY, default 10), and each run has its own call budget (AI_CALL_BUDGET, default 40,
 *   run hourly = 960 a day) that stays under the daily limit. FV2-47: the whole run has a time budget (RUN_BUDGET_MINUTES, default 13)
 *   so it finishes in under 15 minutes however slow the free models are.
 */

/**
 * OpenRouter free models. They are used in rotation (ai.ts), each with its own rate limit, so a longer list is a higher ceiling: the writer
 * only uses the ones the endpoint still lists (resolveModels), so a name that has been retired is harmless. The last entry is OpenRouter's
 * own "pick any free model" router, a safety net.
 */
export const DEFAULT_FREE_MODELS: readonly string[] = [
  // Ordered by the model bench (src/bench.ts, 2026-10-31): the first that is not resting is used, the rest are the fall-back chain.
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'z-ai/glm-4.5-air:free',
  'google/gemma-3-27b-it:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'openai/gpt-oss-20b:free',
  'qwen/qwen3-235b-a22b:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'moonshotai/kimi-k2:free',
  'openrouter/free',
];

/** The Press Box KV namespace the app's Worker reads (workers/press-box/wrangler.toml). */
export const DEFAULT_KV_NAMESPACE_ID = 'd9995262f8404a659e3ea0b880d8493a';

export type RunMode = 'daily' | 'after-game' | 'cleanup';

export interface WriterConfig {
  mode: RunMode;
  /** Stories written per team (1 to 5). */
  storiesPerTeam: number;
  /** Write nothing to the store; the AI and the feeds are still used. */
  dryRun: boolean;
  /** Only these team ids (manual runs); null for every covered team. */
  teamIds: string[] | null;
  /** Teams whose feeds and articles are read at once. */
  concurrency: number;
  /** Teams written up by one AI request (FV2-47): fewer, bigger requests keep a full run inside the free rate limit. */
  batchTeams: number;
  /** The run's time budget in ms (FV2-47: a full run must finish in under 15 minutes). Past it, no new AI request starts and the
   *  teams not yet written keep yesterday's stories, to be picked up by the next run. */
  runBudgetMs: number;
  teamSiteFeeds?: Record<string, string>;
  /** FV2-154: extra trusted outlets beyond the built-in list, "host=Name,host=Name" (env EXTRA_OUTLETS); the hosts of teamSiteFeeds are trusted already. */
  extraOutlets?: string;
  ai: {
    baseUrl: string;
    apiKey: string;
    models: string[];
    /** Spread requests over the models in turn (AI_ROTATE=1) instead of using the first one that is not resting. */
    rotate: boolean;
    /** Smallest gap between two AI request STARTS, ms (free models allow about 20 a minute). */
    paceMs: number;
    /** AI requests in flight at once (the pace above still applies to when each one starts). Absent: one at a time. */
    concurrency?: number;
    /** When the run's time budget ends (epoch ms), set by main.ts at the start of the run. Absent: no limit. */
    deadlineAt?: number;
    /** Longest one request waits for a resting model to come back before giving up, ms (ai.ts). Absent: 2 minutes. */
    maxWaitMs?: number;
    /** Tries per model before moving to the next one. */
    maxRetries: number;
    timeoutMs: number;
    /** Most AI requests (every try counts) this run may make. */
    callBudget: number;
  };
  kv: { accountId: string; apiToken: string; namespaceId: string };
}

export class ConfigError extends Error {}

const positive = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Settings from environment variables. Throws ConfigError naming every missing required one. */
export const cleanSecret = (value: string | undefined): string => (value ?? '').replace(/\s+/g, '');

export function loadConfig(env: Record<string, string | undefined> = process.env): WriterConfig {
  const mode: RunMode = env.PRESS_BOX_MODE === 'after-game' ? 'after-game' : env.PRESS_BOX_MODE === 'cleanup' ? 'cleanup' : 'daily';
  const dryRun = /^(1|true|yes)$/i.test(env.DRY_RUN ?? '');
  const apiKey = cleanSecret(env.AI_API_KEY) || cleanSecret(env.OPENROUTER_API_KEY);
  const accountId = cleanSecret(env.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = cleanSecret(env.CLOUDFLARE_API_TOKEN);

  const missing: string[] = [];
  if (mode !== 'cleanup' && !apiKey) missing.push('OPENROUTER_API_KEY (or AI_API_KEY)');
  const needsStoreAccess = !dryRun || mode === 'cleanup';
  if (needsStoreAccess && !accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (needsStoreAccess && !apiToken) missing.push('CLOUDFLARE_API_TOKEN');
  if (missing.length > 0) throw new ConfigError(`Missing settings: ${missing.join(', ')}. Set them as GitHub Actions secrets.`);

  let teamSiteFeeds: Record<string, string> | undefined;
  if (env.TEAM_SITE_FEEDS) {
    try {
      teamSiteFeeds = JSON.parse(env.TEAM_SITE_FEEDS) as Record<string, string>;
    } catch {
      throw new ConfigError('TEAM_SITE_FEEDS must be JSON like {"nfl-lions": "https://..."}');
    }
  }
  const models = (env.AI_MODELS ?? '').split(',').map((model) => model.trim()).filter(Boolean);
  const teamIds = (env.PRESS_BOX_TEAMS ?? '').split(',').map((id) => id.trim()).filter(Boolean);

  return {
    mode,
    storiesPerTeam: Math.min(5, Math.floor(positive(env.STORIES_PER_TEAM, 4))),
    dryRun,
    teamIds: teamIds.length > 0 ? teamIds : null,
    concurrency: Math.min(24, Math.floor(positive(env.CONCURRENCY, 12))),
    batchTeams: Math.min(8, Math.floor(positive(env.BATCH_TEAMS, 3))),
    runBudgetMs: Math.round(positive(env.RUN_BUDGET_MINUTES, 12) * 60_000),
    teamSiteFeeds,
    extraOutlets: env.EXTRA_OUTLETS,
    ai: {
      baseUrl: (env.AI_BASE_URL || 'https://openrouter.ai/api/v1').trim().replace(/\/$/, ''),
      apiKey,
      models: models.length > 0 ? models : [...DEFAULT_FREE_MODELS],
      rotate: /^(1|true|yes)$/i.test((env.AI_ROTATE ?? '').trim()),
      paceMs: positive(env.AI_PACE_MS, 3_500),
      concurrency: Math.min(16, Math.floor(positive(env.AI_CONCURRENCY, 10))),
      maxWaitMs: Math.round(positive(env.AI_MAX_WAIT_SECONDS, 120) * 1_000),
      maxRetries: Math.floor(positive(env.AI_MAX_RETRIES, 3)),
      timeoutMs: positive(env.AI_TIMEOUT_MS, 120_000),
      callBudget: Math.floor(positive(env.AI_CALL_BUDGET, 40)),
    },
    kv: { accountId, apiToken, namespaceId: (env.PRESS_BOX_KV_NAMESPACE_ID || DEFAULT_KV_NAMESPACE_ID).trim() },
  };
}
