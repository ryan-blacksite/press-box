/**
 * Purpose: command-line entry of the Press Box writer job: `npx vite-node src/main.ts`.
 * Owns: wiring the real network, clock and settings into runPressBox() and setting the process exit code.
 * Notes: Run hourly by .github/workflows/press-box.yml and by hand from the Actions tab. Settings come from environment variables (config.ts); a missing secret is reported by name
 *   and the run ends without touching anything. With DRY_RUN=1 nothing is written to the store.
 */
import { appendFileSync } from 'node:fs';
import { createAiClient, resolveModels } from './ai';
import { ConfigError, loadConfig } from './config';
import { PRESS_BOX_USER_AGENT } from './httpClient';
import { createKv } from './kv';
import { createRobotsFetcher } from './robots';
import { aiWarning, exitCodeFor, formatSummary, runPressBox } from './run';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const fetcher: typeof fetch = (input, init) => fetch(input, init);
  // FV2-47: the run's time budget starts now. Past it the AI client starts no new request (ai.ts), so the run ends on time.
  config.ai.deadlineAt = Date.now() + config.runBudgetMs;
  const models = config.mode === 'cleanup' ? [] : await resolveModels(config.ai, fetcher);
  console.log(JSON.stringify({ event: 'press-box-start', mode: config.mode, dryRun: config.dryRun, models, storiesPerTeam: config.storiesPerTeam, callBudget: config.ai.callBudget, batchTeams: config.batchTeams, aiConcurrency: config.ai.concurrency, runBudgetMinutes: Math.round(config.runBudgetMs / 60_000) }));

  // Sites we read (feeds, articles) are fetched through robots.txt; the AI and the store are APIs and use the plain fetcher.
  const summary = await runPressBox(config, {
    fetcher: createRobotsFetcher(fetcher, PRESS_BOX_USER_AGENT),
    kv: config.dryRun && !config.kv.apiToken ? null : createKv(config.kv, { fetcher, sleep }),
    ai: createAiClient(config.ai, models, { fetcher, sleep, now: () => Date.now() }),
    now: () => Date.now(),
    log: (line) => console.log(line),
  });

  const markdown = formatSummary(summary);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  // A yellow annotation on the run, not a red job: the run did its job, the free models were the problem.
  const warning = aiWarning(summary);
  if (warning) console.log(`::warning title=Press Box AI::${warning}`);
  process.exitCode = exitCodeFor(summary);
}

void main();
