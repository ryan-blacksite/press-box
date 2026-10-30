/**
 * Purpose: ask an OpenAI-compatible chat model for text, politely, on free limits (FV2-16).
 * Owns: createAiClient() (chat), resolveModels(), the pacing, retry/backoff and model fall-back, and the call count.
 * Notes: Works with any OpenAI-compatible /chat/completions endpoint, so a different provider is a setting change (config.ts).
 *   Request STARTS are spaced at least paceMs apart (the free limit is a rate, about 20 a minute), and up to `concurrency` requests may
 *   be in flight at once (FV2-47: one at a time made a 290-team run take hours, because each reply takes 30 to 90 seconds). A 429 or 5xx is retried after
 *   the server's Retry-After or a doubling pause; a model that keeps failing, or is gone (400, 402, 404), is skipped for ten minutes
 *   and the next model in the list is used. A bad key (401) stops the run. OpenRouter 403 means forbidden
 *   (permission, guardrail, or moderation), so that model is skipped and the next configured model is tried. When every
 *   model fails, chat() throws AiUnavailableError and the caller keeps yesterday's stories.
 *   FV2-47: models are used in ROTATION (each request goes to the next model that is not resting), and a model that fails rests on its
 *   own clock: 20 s doubling to 2 minutes after a 429 (or its Retry-After), 10 s doubling to 90 s after anything else, ten minutes if it
 *   is gone or forbidden. When EVERY model is resting, a call waits for the first to come back (up to maxWaitMs) instead of failing at
 *   once; that is what used to leave most of a run on yesterday's stories. Every request counts toward
 *   callBudget; at the budget chat() throws AiBudgetError. `deadlineAt` (an epoch ms) is the run's time budget: once it passes, no new
 *   request starts (chat() throws AiBudgetError, so callers keep yesterday's stories) and a request in flight is cut off 20 s after it,
 *   so a run always ends on time. Secrets are only ever in the Authorization header.
 */
import type { WriterConfig } from './config';
import { APP_NAME, SITE_URL } from './httpClient';

/** How long a model that is gone, forbidden or not allowed for this account is skipped. */
export const DEAD_MODEL_MS = 10 * 60_000;

/** A rate-limited model rests 20 s, then 40, 80 ... up to 2 minutes; any other failure (5xx, a dropped connection, an empty reply) 10 s, doubling up to 90. */
const RATE_LIMIT_BACKOFF_MS = 20_000;
const SHORT_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 120_000;
const backoffMs = (strikes: number, first: number): number => Math.min(first * 2 ** Math.min(strikes, 6), MAX_BACKOFF_MS);

/** Longest one call waits for a resting model to come back before it gives up (the run then retries the teams later). */
export const DEFAULT_MAX_WAIT_MS = 120_000;

export class AiUnavailableError extends Error {}
export class AiBudgetError extends Error {}
export class AiAuthError extends Error {}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface AiDeps {
  fetcher: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface ChatOptions {
  /** Most tokens the reply may use (a batch of several teams needs more than one team does). */
  maxTokens?: number;
}

/** How long past the run's deadline a request already in flight is left to finish. */
export const DEADLINE_GRACE_MS = 20_000;

export interface AiClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<{ content: string; model: string }>;
  stats(): { calls: number; retries: number; modelsUsed: Record<string, number>; deadModels: string[] };
}

/** The configured models that the endpoint still lists. If it has no usable list, the configured ones as they are. */
export async function resolveModels(config: WriterConfig['ai'], fetcher: typeof fetch): Promise<string[]> {
  try {
    const res = await fetcher(`${config.baseUrl}/models`, { headers: { accept: 'application/json' } });
    if (!res.ok) return config.models;
    const body = (await res.json()) as { data?: { id?: string }[] };
    const listed = new Set((body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === 'string'));
    if (listed.size === 0) return config.models;
    const usable = config.models.filter((id) => listed.has(id) || id === 'openrouter/free');
    return usable.length > 0 ? usable : config.models;
  } catch {
    return config.models;
  }
}

/** Reasoning models may put their thinking in the reply; it is not part of the answer. */
export function cleanReply(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function createAiClient(config: WriterConfig['ai'], models: string[], deps: AiDeps): AiClient {
  // Each model has its own cool-down: a model that failed is left alone for a while (a free model's rate-limit spell passes), not for
  // the whole run, and each further failure in a row doubles the wait. A model that works is forgotten (no strikes).
  const cooling = new Map<string, { until: number; strikes: number }>();
  const isCooling = (model: string) => (cooling.get(model)?.until ?? 0) > deps.now();
  const used: Record<string, number> = {};
  let calls = 0;
  let retries = 0;
  let lastCallAt = 0;
  // Requests start in turn, round the list: the free models are limited one by one, so spreading the work keeps each one under its limit.
  let cursor = 0;
  // Request starts go through one gate, in order, so the spacing below is right however many requests are in flight.
  let gate: Promise<unknown> = Promise.resolve();
  const limit = Math.max(1, Math.floor(config.concurrency ?? 1));
  let active = 0;
  const waiting: (() => void)[] = [];
  const maxWaitMs = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return;
    }
    // The slot is handed over by release(), so `active` stays the same.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  function pace(): Promise<void> {
    const turn = gate.then(async () => {
      const wait = lastCallAt + config.paceMs - deps.now();
      if (wait > 0) await deps.sleep(wait);
      lastCallAt = deps.now();
    });
    gate = turn.catch(() => undefined);
    return turn;
  }

  const pastDeadline = () => config.deadlineAt !== undefined && deps.now() >= config.deadlineAt;

  async function request(model: string, messages: ChatMessage[], maxTokens: number): Promise<Response | null> {
    if (calls >= config.callBudget) throw new AiBudgetError(`AI call budget of ${config.callBudget} reached`);
    if (pastDeadline()) throw new AiBudgetError('The run\'s time budget is spent');
    await pace();
    if (pastDeadline()) throw new AiBudgetError('The run\'s time budget is spent');
    calls += 1;
    const controller = new AbortController();
    const allowed = config.deadlineAt === undefined ? config.timeoutMs : Math.min(config.timeoutMs, Math.max(1_000, config.deadlineAt + DEADLINE_GRACE_MS - deps.now()));
    const timer = setTimeout(() => controller.abort(), allowed);
    try {
      return await deps.fetcher(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          // OpenRouter shows these on its dashboard; other providers ignore them.
          'http-referer': SITE_URL,
          'x-title': APP_NAME,
        },
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens }),
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The next model that is not cooling, in rotation; null when every one is. */
  function pick(): string | null {
    for (let step = 0; step < models.length; step += 1) {
      const index = (cursor + step) % models.length;
      if (!isCooling(models[index])) {
        cursor = (index + 1) % models.length;
        return models[index];
      }
    }
    return null;
  }

  /** Leave a model alone for `ms`, longer for each failure in a row. */
  function coolDown(model: string, ms: number, struck: boolean): void {
    const strikes = (cooling.get(model)?.strikes ?? 0) + (struck ? 1 : 0);
    cooling.set(model, { until: deps.now() + ms, strikes });
  }

  async function chatOnce(messages: ChatMessage[], maxTokens: number): Promise<{ content: string; model: string }> {
    // Every model is tried about maxRetries times at most before the call gives up; a call also gives up when the models are all cooling
    // for longer than it is willing to wait (maxWaitMs), so one batch never holds a lane for minutes.
    const attemptsAllowed = Math.max(1, config.maxRetries) * Math.max(1, models.length);
    let attempts = 0;
    let waited = 0;
    for (;;) {
      const model = pick();
      if (!model) {
        const next = Math.min(...models.map((candidate) => cooling.get(candidate)?.until ?? 0));
        const wait = Math.max(1, next - deps.now());
        if (waited + wait > maxWaitMs) throw new AiUnavailableError('Every AI model is resting.');
        if (config.deadlineAt !== undefined && deps.now() + wait >= config.deadlineAt) throw new AiBudgetError('The run\'s time budget is spent');
        await deps.sleep(wait);
        waited += wait;
        continue;
      }
      if (attempts >= attemptsAllowed) throw new AiUnavailableError('Every AI model failed.');
      attempts += 1;
      const res = await request(model, messages, maxTokens);
      if (res && res.ok) {
        try {
          const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
          const content = body.choices?.[0]?.message?.content;
          if (typeof content === 'string' && cleanReply(content)) {
            used[model] = (used[model] ?? 0) + 1;
            cooling.delete(model);
            return { content: cleanReply(content), model };
          }
        } catch {
          // An unreadable reply is treated like a failed try.
        }
        retries += 1;
        coolDown(model, backoffMs(cooling.get(model)?.strikes ?? 0, SHORT_BACKOFF_MS), true);
        continue;
      }
      if (res?.status === 401) throw new AiAuthError(`The AI endpoint refused the key (${res.status}).`);
      // The model is gone, forbidden, or not allowed for this account: leave it alone for a long while.
      if (res && (res.status === 400 || res.status === 402 || res.status === 403 || res.status === 404)) {
        coolDown(model, DEAD_MODEL_MS, false);
        continue;
      }
      retries += 1;
      const strikes = cooling.get(model)?.strikes ?? 0;
      const retryAfter = Number(res?.headers.get('retry-after'));
      if (res?.status === 429) {
        // Rate limited: the server's own Retry-After if it gave one, else a doubling pause from 20 s.
        const asked = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1_000 : backoffMs(strikes, RATE_LIMIT_BACKOFF_MS);
        coolDown(model, asked, true);
      } else {
        coolDown(model, backoffMs(strikes, SHORT_BACKOFF_MS), true);
      }
    }
  }

  return {
    async chat(messages, options) {
      await acquire();
      try {
        return await chatOnce(messages, options?.maxTokens ?? 2_000);
      } finally {
        release();
      }
    },
    stats: () => ({ calls, retries, modelsUsed: { ...used }, deadModels: [...cooling.keys()].filter(isCooling) }),
  };
}
