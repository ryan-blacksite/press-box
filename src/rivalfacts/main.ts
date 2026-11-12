/** Command line entry of `npm run rivalfacts -- <league>` (FV2-234): see publish.ts. DRY_RUN=1 writes nothing. */
import { DEFAULT_KV_NAMESPACE_ID } from '../config';
import { createKv } from '../kv';
import { publishRivalFacts } from './publish';

async function main(): Promise<void> {
  const league = (process.argv[2] || 'nfl').toLowerCase();
  const dryRun = process.env.DRY_RUN === '1';
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
  if (!dryRun && (!accountId || !apiToken)) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed (or set DRY_RUN=1)');
  const kv = dryRun ? null : createKv({ accountId, apiToken, namespaceId: (process.env.PRESS_BOX_KV_NAMESPACE_ID || DEFAULT_KV_NAMESPACE_ID).trim() }, { fetcher: fetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
  const result = await publishRivalFacts(league, kv, { dryRun });
  console.log(`${result.key}: ${dryRun ? 'dry run, would write' : result.wrote ? 'written' : 'unchanged'}, ${result.bytes} bytes`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
