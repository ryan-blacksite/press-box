/**
 * Purpose: one run of the Press Box writer (FV2-16): decide which teams to work on, write their stories into the store, and
 *   report what happened.
 * Owns: coveredTeams(), runPressBox() (the whole run) and formatSummary().
 * Notes: For each team: read what is stored, pull the news feeds, and SKIP the team (no AI call) when nothing new has been
 *   published since its last write. Otherwise build up to 3 stories with ONE AI call (stories.ts) and write them. If the AI cannot be
 *   used the stored stories are kept (re-saved so they do not expire) rather than writing nothing; a team with nothing stored
 *   yet gets the feed headlines. Daily mode covers every team (early morning, US Eastern); after-game mode only the covered teams whose
 *   game went final today (afterGame.ts), so the result is in the store that night. Per team and per run it logs JSON lines (event
 *   press-box-team / press-box-run) with teams checked, skipped, AI calls and failures. Nothing here logs a key or a token.
 *   FV2-47: NOTHING is written per team. Stories are staged in memory and a league's bundle (bundle:<league>, bundles.ts) is written
 *   once, after both phases, and only if it changed; a skipped team stages nothing, so a run costs at most a handful of KV writes (one
 *   per league that changed), never ~290. The write count is in the run summary.
 *   FV2-47: a run finishes in under 15 minutes. It has two phases: (1) many teams at once read their feeds and articles and are
 *   skipped, or queued for the AI; (2) the queued teams are written up several at a time, one AI request per batch (BATCH_TEAMS), a few
 *   requests in flight at once. The run has a time budget (config.runBudgetMs): when it is spent, teams not yet started are DEFERRED
 *   (nothing is written for them, so the next run picks them up) and the AI client stops starting requests, so teams already read
 *   keep yesterday's stories. The summary prints the total minutes. Phase 2 starts while phase 1 is still reading (a team goes to the
 *   AI as soon as a batch of them is ready), and a team whose AI request failed is not given up on: it is tried again later in the same run
 *   (RETRY_PASSES), while time remains, and only then kept as yesterday's. A run is red only when something FAILED (exitCodeFor), never
 *   because the free models were slow: that is a warning in the summary.
 */
import { collectItems, memoizeFeeds } from './feeds';
import { trustFor } from './outlets';
import { finishedTeamIds } from './afterGame';
import { AiAuthError, type AiClient } from './ai';
import { createBundles } from './bundles';
import type { KvStore } from './kv';
import { clusterItems, rankClusters } from './rank';
import { buildTeamsBatch, prepareTeam, type PreparedTeam, type TeamBuild } from './stories';
import { TEAMS, type PressBoxTeam } from './shared/teams';
import type { TeamStories } from './shared/types';
import type { WriterConfig } from './config';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Every team Press Box covers: the whole list in the teams file (config/teams.fly.json for FLY). */
export function coveredTeams(): PressBoxTeam[] {
  return [...TEAMS];
}

export type TeamOutcome = 'written' | 'cleaned' | 'would-clean' | 'skipped-no-news' | 'kept-yesterday' | 'fallback-written' | 'empty-written' | 'failed';

export interface TeamReport {
  team: string;
  outcome: TeamOutcome;
  stories?: number;
  aiCalls?: number;
  aiStories?: number;
  fallbackStories?: number;
  removedOffSport?: number;
  feedItems?: number;
  error?: string;
}

export interface RunSummary {
  mode: WriterConfig['mode'];
  dryRun: boolean;
  teamsInScope: number;
  checked: number;
  written: number;
  skippedNoNews: number;
  keptYesterday: number;
  fallbackWritten: number;
  emptyWritten: number;
  removedOffSport: number;
  cleanupCandidates: number;
  cleanedTeams: number;
  failures: { team: string; error: string }[];
  aiCalls: number;
  aiRetries: number;
  modelsUsed: Record<string, number>;
  /** KV writes this run made: one per league bundle that changed. The free plan allows 1,000 a day. */
  kvWrites: number;
  /** KV reads this run made (a bundle per league, plus the old per-team items once, to seed a bundle). */
  kvReads: number;
  /** Each bundle written, with its size in characters. */
  kvBundlesWritten: Record<string, number>;
  /** Teams written up together in one AI request, per request (FV2-47). */
  aiBatches: number;
  /** Teams not started because the run's time budget was spent (FV2-47): the next run picks them up. */
  deferred: number;
  seconds: number;
  /** A fatal problem (a rejected key) that stopped the run early. */
  fatal?: string;
}

export interface RunDeps {
  fetcher: Fetcher;
  kv: KvStore | null;
  ai: AiClient;
  now: () => number;
  log: (line: string) => void;
}

/** Run `work` over the items, `limit` at a time, in order of start. */
async function inPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

export async function runPressBox(config: WriterConfig, deps: RunDeps): Promise<RunSummary> {
  const startedAt = deps.now();
  let teams = coveredTeams();
  if (config.teamIds) {
    const wanted = new Set(config.teamIds);
    teams = teams.filter((team) => wanted.has(team.id));
  }
  if (config.mode === 'after-game') {
    const finished = await finishedTeamIds(teams, deps.fetcher, deps.now(), (message) => deps.log(JSON.stringify({ event: 'press-box-warn', message })));
    teams = teams.filter((team) => finished.has(team.id));
  }

  const summary: RunSummary = {
    mode: config.mode,
    dryRun: config.dryRun,
    teamsInScope: teams.length,
    checked: 0,
    written: 0,
    skippedNoNews: 0,
    keptYesterday: 0,
    fallbackWritten: 0,
    emptyWritten: 0,
    removedOffSport: 0,
    cleanupCandidates: 0,
    cleanedTeams: 0,
    failures: [],
    aiCalls: 0,
    aiRetries: 0,
    modelsUsed: {},
    kvWrites: 0,
    kvReads: 0,
    kvBundlesWritten: {},
    aiBatches: 0,
    deferred: 0,
    seconds: 0,
  };
  let stopped = false;
  // Phase 1 (feeds and articles) may use the first part of the budget; the AI needs the rest.
  const budgetEnds = startedAt + config.runBudgetMs;
  const readingEnds = startedAt + Math.round(config.runBudgetMs * 0.6);

  // FV2-47: the store is one bundle per league. Load each league's once, work the teams, write each league once when both phases are done.
  const bundles = createBundles(deps.kv, { dryRun: config.dryRun });
  // FV2-154: the sources a story may be read from and credited to.
  const trust = trustFor(config.teamSiteFeeds, config.extraOutlets);
  // Each league-wide feed is read once per run, not once per team.
  const feedFetcher = memoizeFeeds(deps.fetcher);
  const leagueNames = Array.from(new Set(teams.map((team) => team.league)));
  const leagueTeams = new Map(leagueNames.map((league) => [league, coveredTeams().filter((team) => team.league === league)]));
  await Promise.all(leagueNames.map((league) => bundles.load(league, leagueTeams.get(league) ?? [])));

  /** Stage a team's new value; the league's item is written once, below. */
  function stage(team: PressBoxTeam, value: TeamStories): void {
    // A dry run writes nothing, so show what WOULD be stored: that is what a person reads to judge the quality.
    if (config.dryRun && value.stories.length > 0) {
      deps.log(JSON.stringify({ event: 'press-box-dry-story', team: team.id, stories: value.stories.map((story) => ({ headline: story.headline, summary: story.summary, sources: story.sources.map((source) => `${source.name} ${source.url}`) })) }));
    }
    bundles.set(team, value);
  }

  /** A team that needs the AI: everything the second phase needs to write it and report on it. */
  interface Waiting {
    team: PressBoxTeam;
    report: TeamReport;
    prepared: PreparedTeam;
    prev: TeamStories | null;
    removedOffSport: number;
    now: number;
  }
  // Phase 1 feeds phase 2: a team joins the queue the AI lanes draw batches from as soon as its feeds and articles are read.
  const ready: Waiting[] = [];
  let reading = true;
  let sleepers: (() => void)[] = [];
  const nudge = () => {
    const woken = sleepers;
    sleepers = [];
    woken.forEach((wake) => wake());
  };
  /** The next batch for an AI lane: a full one, or what is left once reading is over; null when there is nothing more to come. */
  async function nextBatch(): Promise<Waiting[] | null> {
    for (;;) {
      if (stopped) return null;
      if (ready.length >= config.batchTeams || (!reading && ready.length > 0)) return ready.splice(0, config.batchTeams);
      if (!reading) return null;
      await new Promise<void>((resolve) => { sleepers.push(resolve); });
    }
  }

  function fail(team: PressBoxTeam, report: TeamReport, error: unknown): void {
    if (error instanceof AiAuthError) {
      stopped = true;
      summary.fatal = error.message;
      nudge();
    }
    const message = error instanceof Error ? error.message : String(error);
    report.error = message;
    report.outcome = 'failed';
    summary.failures.push({ team: team.id, error: message });
  }

  /** Phase 1: read what is stored and the feeds and articles. Teams that need no AI are finished here. */
  async function prepareOne(team: PressBoxTeam): Promise<void> {
    if (stopped) return;
    if (deps.now() >= readingEnds) {
      summary.deferred += 1;
      return;
    }
    const report: TeamReport = { team: team.id, outcome: 'failed' };
    let queued = false;
    try {
      const prev = bundles.get(team);
      const rawStories = bundles.raw(team)?.stories;
      const removedOffSport = Array.isArray(rawStories) && prev ? Math.max(0, rawStories.length - prev.stories.length) : 0;
      report.removedOffSport = removedOffSport;
      summary.removedOffSport += removedOffSport;
      const now = deps.now();

      if (config.mode === 'cleanup') {
        summary.checked += 1;
        if (removedOffSport > 0 && prev) {
          summary.cleanupCandidates += 1;
          if (!config.dryRun && deps.kv) {
            stage(team, prev);
            summary.cleanedTeams += 1;
          }
        }
        report.outcome = removedOffSport > 0 ? config.dryRun ? 'would-clean' : 'cleaned' : 'skipped-no-news';
        report.stories = prev?.stories.length ?? 0;
        return;
      }

      const { items } = await collectItems(team, config.teamSiteFeeds, feedFetcher, now, trust, (message) => deps.log(JSON.stringify({ event: 'press-box-warn', team: team.id, message })));
      report.feedItems = items.length;
      summary.checked += 1;

      // News check first: nothing published since the last write means no AI call (the off-season takes care of itself).
      const lastWrite = prev ? Date.parse(prev.updatedAt) || 0 : 0;
      if (prev && !items.some((item) => item.publishedAt > lastWrite)) {
        // Nothing to write: the team's entry in its bundle stays as it is (a nonmatching story is filtered out, below).
        if (removedOffSport > 0) stage(team, prev);
        summary.skippedNoNews += 1;
        report.outcome = 'skipped-no-news';
        return;
      }
      if (!prev && items.length === 0) {
        const empty: TeamStories = { teamId: team.id, updatedAt: new Date(now).toISOString(), stories: [] };
        stage(team, empty);
        summary.emptyWritten += 1;
        report.outcome = 'empty-written';
        report.stories = 0;
        return;
      }

      const ranked = rankClusters(clusterItems(items), now);
      const prepared = await prepareTeam(team, ranked, config.storiesPerTeam, deps.fetcher, trust);
      ready.push({ team, report, prepared, prev, removedOffSport, now });
      queued = true;
      nudge();
    } catch (error) {
      fail(team, report, error);
    } finally {
      if (!queued) deps.log(JSON.stringify({ event: 'press-box-team', ...report }));
    }
  }

  /** Teams whose AI request failed: tried again later in the run, then finished with what they have (yesterday's stories or the headlines). */
  const retryLater: { entry: Waiting; build: TeamBuild }[] = [];

  /** Store a team's result and report it. */
  function finishEntry(entry: Waiting, build: TeamBuild): void {
    const { team, report, prev, removedOffSport, now } = entry;
    try {
      report.aiCalls = build.aiCalls;
      report.aiStories = build.aiStories;
      report.fallbackStories = build.fallbackStories;
      report.stories = build.stories.length;

      if ((build.aiFailed || build.stories.length === 0) && prev) {
        // Keep yesterday's stories rather than writing nothing (or only headlines).
        if (removedOffSport > 0) stage(team, prev as TeamStories);
        summary.keptYesterday += 1;
        report.outcome = 'kept-yesterday';
        return;
      }
      const value: TeamStories = { teamId: team.id, updatedAt: new Date(now).toISOString(), stories: build.stories };
      stage(team, value);
      if (build.aiFailed) {
        summary.fallbackWritten += 1;
        report.outcome = 'fallback-written';
      } else if (build.stories.length === 0) {
        summary.emptyWritten += 1;
        report.outcome = 'empty-written';
      } else {
        summary.written += 1;
        report.outcome = 'written';
      }
    } catch (error) {
      fail(team, report, error);
    } finally {
      deps.log(JSON.stringify({ event: 'press-box-team', ...report }));
    }
  }

  /** Phase 2: write a batch of teams with one AI request. A team the AI could not be used for is queued to try again, not given up on. */
  async function writeBatch(batch: Waiting[]): Promise<void> {
    if (stopped) return;
    summary.aiBatches += 1;
    let builds;
    try {
      builds = await buildTeamsBatch(batch.map((entry) => entry.prepared), config.storiesPerTeam, { ai: deps.ai, now: deps.now() });
    } catch (error) {
      // A rejected key: nothing after it can work. It is ONE failure (the run's), and the batch's teams are logged as not written.
      fail(batch[0].team, batch[0].report, error);
      for (const entry of batch) {
        if (entry !== batch[0]) entry.report.error = 'not written: the run stopped';
        deps.log(JSON.stringify({ event: 'press-box-team', ...entry.report }));
      }
      return;
    }
    batch.forEach((entry, position) => {
      const build = builds[position];
      if (build.aiFailed) retryLater.push({ entry, build });
      else finishEntry(entry, build);
    });
  }

  const aiLanes = Array.from({ length: Math.max(1, config.ai.concurrency ?? 1) }, async () => {
    for (;;) {
      const batch = await nextBatch();
      if (!batch) return;
      await writeBatch(batch);
    }
  });
  await Promise.all([
    inPool(teams, config.concurrency, prepareOne).finally(() => {
      reading = false;
      nudge();
    }),
    ...aiLanes,
  ]);
  // Teams the AI could not be used for are tried again, while there is time (the AI client waits for a resting model to come back, so
  // each pass is also a rest), and only then kept as yesterday's.
  for (let pass = 1; pass <= RETRY_PASSES && retryLater.length > 0 && !stopped; pass += 1) {
    if (deps.now() >= budgetEnds - MIN_RETRY_MS) break;
    const again = retryLater.splice(0).map((item) => item.entry);
    const chunks: Waiting[][] = [];
    for (let index = 0; index < again.length; index += config.batchTeams) chunks.push(again.slice(index, index + config.batchTeams));
    await inPool(chunks, config.ai.concurrency ?? 1, writeBatch);
  }
  for (const { entry, build } of retryLater.splice(0)) finishEntry(entry, build);
  // A run stopped early (a rejected AI key) still saves what it did.
  for (const league of leagueNames) {
    try {
      await bundles.flush(league);
    } catch (error) {
      summary.failures.push({ team: `bundle:${league.toLowerCase()}`, error: error instanceof Error ? error.message : String(error) });
    }
  }
  summary.kvWrites = bundles.writes;
  summary.kvReads = bundles.reads;
  summary.kvBundlesWritten = Object.fromEntries(bundles.written);

  const stats = deps.ai.stats();
  summary.aiCalls = stats.calls;
  summary.aiRetries = stats.retries;
  summary.modelsUsed = stats.modelsUsed;
  summary.seconds = Math.round((deps.now() - startedAt) / 1000);
  deps.log(JSON.stringify({ event: 'press-box-run', ...summary, failures: summary.failures.length }));
  return summary;
}

/** A run that writes this many KV items or more is flagged in the summary (a full run is 7). */
export const KV_WRITE_WARNING = 50;

/** How many more times a team whose AI request failed is tried within one run, and the least time (ms) left for another try to be worth starting. */
export const RETRY_PASSES = 2;
const MIN_RETRY_MS = 90_000;

/** The longest a full run should take (FV2-47): GitHub's free Actions allowance on a private repo is 2,000 minutes a month. */
export const RUN_MINUTES_TARGET = 15;

/** "7 min 32 s" for the summary. */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/** The run as a short Markdown table for the GitHub Actions job summary. */
export function formatSummary(summary: RunSummary): string {
  const rows: [string, string | number][] = [
    ['Mode', `${summary.mode}${summary.dryRun ? ' (dry run: nothing written)' : ''}`],
    ['Teams in scope', summary.teamsInScope],
    ['Teams checked', summary.checked],
    ['Stories written (AI)', summary.written],
    ['Stored team records needing cleanup', summary.cleanupCandidates],
    ['Stored team records rewritten', summary.cleanedTeams],
    ['Skipped, no new news (no AI call)', summary.skippedNoNews],
    ['Kept yesterday (AI unavailable)', summary.keptYesterday],
    ['Written from feed headlines only', summary.fallbackWritten],
    ['Written empty (no news yet)', summary.emptyWritten],
    ['Nonmatching stories filtered', summary.removedOffSport],
    ['Failures', summary.failures.length],
    ['AI requests (incl. retries)', summary.aiCalls],
    ['AI batches (teams written per request)', summary.aiBatches],
    ['Teams deferred to the next run (time budget)', summary.deferred],
    ['KV writes (free plan: 1,000 a day)', `${summary.kvWrites}${summary.kvWrites > 0 ? ` (${Object.keys(summary.kvBundlesWritten).join(', ')})` : ''}`],
    ['KV reads', summary.kvReads],
    ['Total time', formatDuration(summary.seconds)],
  ];
  const lines = ['### Press Box writer', '', '| | |', '|---|---|', ...rows.map(([label, value]) => `| ${label} | ${value} |`)];
  const models = Object.entries(summary.modelsUsed);
  if (models.length > 0) lines.push('', `Models used: ${models.map(([model, count]) => `${model} x${count}`).join(', ')}`);
  if (summary.kvWrites >= KV_WRITE_WARNING) lines.push('', `**KV writes: ${summary.kvWrites}.** A run should stay under ${KV_WRITE_WARNING} (the free plan allows 1,000 a day for the whole account).`);
  if (summary.seconds > RUN_MINUTES_TARGET * 60) lines.push('', `**This run took ${formatDuration(summary.seconds)}.** A run should stay under ${RUN_MINUTES_TARGET} minutes (GitHub's free Actions allowance is 2,000 minutes a month).`);
  const warning = aiWarning(summary);
  if (warning) lines.push('', `**Warning:** ${warning}`);
  if (summary.deferred > 0) lines.push('', `${summary.deferred} teams were left for the next run because the run's time budget was spent.`);
  if (summary.fatal) lines.push('', `**Stopped early:** ${summary.fatal}`);
  if (summary.failures.length > 0) lines.push('', 'Failures:', ...summary.failures.slice(0, 20).map((failure) => `- ${failure.team}: ${failure.error}`));
  return `${lines.join('\n')}\n`;
}

/**
 * The run's exit code: 1 only when something FAILED: a rejected key (fatal) or a failure listed in the summary (a team, a bundle that
 * could not be written). The AI being slow or unavailable for some teams is NOT a failure of the run (yesterday's stories are kept and the
 * summary says how many); it is a warning (aiWarning) so a run that did its job is green.
 */
export function exitCodeFor(summary: RunSummary): number {
  if (summary.fatal) return 1;
  return summary.failures.length > 0 ? 1 : 0;
}

/** Teams that kept yesterday's stories (or only the feed headlines) at or above this many are flagged in the summary and as a warning. */
export const AI_WARNING_TEAMS = 20;

/** A short sentence when the AI could not be used for many teams, else null. */
export function aiWarning(summary: RunSummary): string | null {
  const degraded = summary.keptYesterday + summary.fallbackWritten;
  return degraded >= AI_WARNING_TEAMS ? `${degraded} teams kept yesterday's stories or got feed headlines only because the free AI models were unavailable or too slow (${summary.written} teams got new stories).` : null;
}
