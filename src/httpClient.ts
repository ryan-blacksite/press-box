/**
 * Purpose: shared outbound HTTP settings for the Press Box Worker (FV2-3).
 * Owns: the User-Agent string and fetch timeout defaults used by feeds and article fetches.
 * Notes: A proper browser-like UA avoids RSS endpoints blocking Cloudflare Worker IPs.
 */

/** Who the summaries are written for and where a site owner can read about this bot. Set per deployment (see README), never hard-coded to one app. */
export const APP_NAME = process.env.PRESS_BOX_APP_NAME?.trim() || 'Press Box';
export const SITE_URL = process.env.PRESS_BOX_SITE_URL?.trim() || 'https://github.com/ryan-blacksite/press-box';
export const PRESS_BOX_USER_AGENT = `Mozilla/5.0 (compatible; PressBox/1.0; +${SITE_URL})`;
export const FEED_FETCH_TIMEOUT_MS = 6_000;
export const ARTICLE_FETCH_TIMEOUT_MS = 6_000;
