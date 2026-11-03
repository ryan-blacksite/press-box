# Hourly dispatch

The `press-box-hourly-dispatch` Worker calls the existing GitHub Actions workflow at minute 2 of each hour. GitHub's minute-7 schedule remains a backup. Automatic daily runs select one of four partitions by UTC hour; four consecutive successful, timely runs cover all teams. A missed or deferred run can delay a team beyond four hours. Manual team-specific runs bypass partitioning.

## Setup

1. In GitHub, create a fine-grained token limited to `ryan-blacksite/press-box` with Actions: read and write. Do not put it in source control or command history.
2. In Cloudflare, create the Worker with `workers/press-box-dispatch/wrangler.toml`, set `GITHUB_ACTIONS_TOKEN` as an encrypted Worker secret using the dashboard or `wrangler secret put`, and deploy. Ensure the account has an available free Cron Trigger slot.
3. Confirm a scheduled invocation dispatches the workflow and check the run summary for `checked`, `deferred`, feed failures and KV writes. Keep the GitHub schedule enabled.

The workflow permits one free-model request per run, including retries. Two starts each hour therefore allow at most 48 requests/day from these two triggers, provided neither retries a dispatch; manual runs and other uses share OpenRouter's account quota. Source headlines remain available when AI is unavailable. The free quota can still be exhausted by other usage, and free services can reject or delay calls. No spending or purchased credits are required.
