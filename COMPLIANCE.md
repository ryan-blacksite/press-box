# Compliance notes

Checked 2026-10-30 (feeds added 2026-10-31). Re-check before adding a source or turning this into a product for other people.

## Sources

| Source | What we fetch | robots.txt (checked) | Status |
|---|---|---|---|
| ESPN league RSS (`www.espn.com/espn/rss/...`) | headlines, links | allowed for all bots (only `/espn/now` and a few paths disallowed) | OK |
| ESPN team news JSON (`site.web.api.espn.com`) | headlines, links | host's robots.txt answers 403 (treated as no rules) | Tolerated: an unofficial but widely used endpoint with no written permission |
| CBS Sports league RSS (`www.cbssports.com/rss/headlines/<league>/`) | headlines, links | allowed for all bots (only `/info/search`, `/data/*`, login and similar disallowed) | OK (FV2-154 6d) |
| Yahoo Sports league RSS (`sports.yahoo.com/<league>/rss/`) | headlines, links | allowed for all bots (only internal paths disallowed) | OK (FV2-154 6d) |
| MLB.com news RSS (`www.mlb.com/feeds/news/rss.xml`) | headlines, links | allowed (`/api/`, `/test/` etc. disallowed) | OK (FV2-154 6d) |
| Daily Faceoff RSS (`www.dailyfaceoff.com/feed`) | headlines, links | `Allow: /` (only `/api/`, `/cms/` disallowed) | OK (FV2-154 6d) |
| Google News RSS search (`news.google.com/rss/search`) | headlines, links | **disallowed** for `*` (`Disallow: /`, only a few paths allowed) | **Blocked automatically** by `src/robots.ts`. The article-link resolving that followed it is blocked too |
| Publisher article pages | text read to write a summary | each site's own robots.txt, checked per host | Respected; no text stored |
| Team-site feeds (optional `TEAM_SITE_FEEDS`) | headlines | each site's own | Respected |

Google News being blocked is a real loss of coverage for FLY; the writer carries on with the sources that allow it. Adding permitted
sources (team and league RSS feeds with a written feed licence) is the way to widen coverage. Ryan decides.

## Copying

Stories are written in our own words by a model, link to the source, and carry the source's name. The guard (`src/guard.ts`) rejects a
summary that shares a long word-for-word run with the source or states numbers the source does not. The article text is never stored.

## AI provider

OpenRouter ":free" models. **Not yet verified:** that OpenRouter's terms and each free model's licence allow this commercial use, and that
the free-model providers' data-logging terms are acceptable (free endpoints may log prompts; our prompts contain only public headlines).
Check before relying on this commercially.
