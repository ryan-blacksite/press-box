# Press Box

A free sports news fetcher. Every hour it gathers recent headlines for each team on a list, has a free AI model write short **original**
summaries (each links back to its source), and stores them in a Cloudflare KV namespace that an app's Worker serves.

First customer: the FLY app. The story format, storage and the Worker URL FLY reads are unchanged, so FLY needs no changes.

```
GitHub Actions (hourly, free on public repos) -> news feeds -> OpenRouter ":free" models -> Cloudflare KV <- your Worker <- your app
```

## What it does

- Reads each team's news (ESPN RSS and team JSON, optional team-site feeds, Google News where its robots.txt allows it).
- Skips a team with no new article since its last write: no AI call, no write.
- Asks a free model for 4 short summaries per team (3 teams per request). A summary is checked: it must not copy the source's wording
  (a shared-phrase limit), must not state numbers the source does not, and must be about the right sport.
- Stores one item per league (`bundle:nfl`, ...). At most 7 KV writes a run, 0 when nothing changed.

## Respecting sites (see COMPLIANCE.md)

Every feed and article page is fetched through the site's `robots.txt` (`src/robots.ts`). A disallowed page is never requested. The
bot identifies itself as `PressBox/1.0` with a link to this repo. Stories are our own words plus a link; no article text is stored.

## Setup

1. Repo **Settings > Secrets and variables > Actions > Secrets**: `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`
   (Cloudflare token with only **Workers KV Storage: Edit**).
2. Optional **Variables**: `PRESS_BOX_KV_NAMESPACE_ID`, `TEAMS_FILE`, `AI_BASE_URL`, `AI_MODELS`, `PRESS_BOX_APP_NAME`, `PRESS_BOX_SITE_URL`,
   `STORIES_PER_TEAM` (max 5), `AI_CALL_BUDGET` (AI requests per run, default 40).
3. Test: Actions > **Press Box** > Run workflow, teams `nfl-lions`, dry run on. Then again with dry run off.
4. Measure your key: Actions > **Measure AI limits** > Run workflow; read the job summary.

## Using it for another app

Everything app-specific is config:

| What | Where |
|---|---|
| Teams (`id`, `league`, `name`, `abbreviation`, `city`) | `config/teams.fly.json`, or point `TEAMS_FILE` at your own |
| Store (KV namespace) | `PRESS_BOX_KV_NAMESPACE_ID` (FLY's is the built-in default in `src/config.ts`) |
| Name in prompts and the bot's User-Agent | `PRESS_BOX_APP_NAME`, `PRESS_BOX_SITE_URL` |
| AI provider and models | `AI_BASE_URL` (any OpenAI-compatible API), `AI_MODELS` |

`src/shared/` is the story format and the read side; the reading Worker uses the same code (FLY's copy is `workers/press-box` in
fly-frontend). Change the format in both places or in neither.

## Schedule and limits

Hourly (`7 * * * *`). Each run makes at most 40 AI requests (3 teams each), so 24 runs stay under 960 a day, below OpenRouter's free
limit for an account with purchased credits (about 1,000 a day, 20 a minute). With no credits the limit is far lower (about 50 a day):
set `AI_CALL_BUDGET=2` and expect fewer teams per day. `npm run probe` measures the real numbers for your key.

GitHub turns off scheduled workflows in a public repo after 60 days with no repository activity; any commit, or re-enabling the workflow
in the Actions tab, turns it back on.

## Develop

```
npm ci
npm test            # 112 tests, no network
npm run typecheck
DRY_RUN=1 OPENROUTER_API_KEY=... PRESS_BOX_TEAMS=nfl-lions npm run write
```

No secret is ever in the repo. Licence: not chosen yet (all rights reserved until one is added).

## Quality rules (FV2-154 item 6)

- **Summaries state what happened and nothing about the article.** The prompt forbids it and `src/guard.ts` rejects "the article", "does not specify", "is not mentioned", "no information" and the like; a rejected summary is asked for once more with the objection, then the story keeps only the feed's headline. Summaries are 2 to 6 sentences, so the model is never pushed to pad.
- **Only real English sports outlets are read and credited.** `src/outlets.ts` holds the allowlist (ESPN, NHL.com and other league sites, CBS Sports, Yahoo Sports, AP, Daily Faceoff and more). The credit is the allowlist's name for the article's real address, never the feed's free text. Non-English text and unlisted hosts are dropped. Team-site feeds you configure (`TEAM_SITE_FEEDS`) are trusted by their host; add others with `EXTRA_OUTLETS="host=Name,host=Name"`.
- **Non-stories are skipped.** Line combinations, depth charts, stats, standings, schedule, betting and odds guides, predictions, power rankings, trackers, how-to-watch guides, uniform roundups, polls, trivia lists, video highlights, galleries and link roundups are recognised by title, address and content and never become a story.
- **The story is about the team.** A league-wide feed item counts for a team only when its name is in the headline or the first words of the blurb, and an article only when its name is in the opening of the page.
- **A headline-only story follows the same credit rules.** When the article or the AI is unavailable, the story is the feed's headline and blurb, but still only from a trusted outlet, credited by the allowlist's name, once per outlet; with no trusted item there is no story.
- **Article text is read from the page's own prose.** The `<article>` or `<main>` block with the most prose wins (ESPN and Yahoo put teasers for other stories in an earlier one). Every page is still fetched through the robots.txt-checking fetcher, so a page robots.txt disallows is never read.
