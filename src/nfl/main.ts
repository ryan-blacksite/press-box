/**
 * Purpose: command-line entry of the NFL stats job: download nflverse's season file and schedule, write small JSON files to ./site.
 * Owns: `npm run nfl` (npx vite-node src/nfl/main.ts). The workflow then publishes ./site with GitHub Pages.
 * Notes: NFL_SEASON overrides the season (default: this year from March on, else last year). Fails (red) rather than publishing an empty site
 *   when the download fails or has no rows, so a good published site is never replaced by a broken one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildNflFiles, parseCsv } from './build';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

async function download(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'PressBox/1.0 (+https://github.com/ryan-blacksite/press-box)' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const now = new Date();
  const season = Number(process.env.NFL_SEASON) || (now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
  const outDir = process.env.SITE_DIR || 'site';
  const [playerCsv, scheduleCsv] = await Promise.all([download(`${BASE}/stats_player/stats_player_week_${season}.csv`), download(`${BASE}/schedules/games.csv`)]);
  const playerRows = parseCsv(playerCsv);
  if (playerRows.length === 0) throw new Error(`nflverse had no player rows for ${season}`);
  const built = buildNflFiles(playerRows, parseCsv(scheduleCsv), season, now);
  for (const [path, body] of built.files) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  writeFileSync(join(outDir, '.nojekyll'), '');
  const summary = `NFL ${season}: ${built.games} games and ${built.teams} teams written, ${[...built.files.values()].reduce((sum, body) => sum + body.length, 0)} bytes.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
