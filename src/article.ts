/**
 * Purpose: get the text of an article so the AI can summarize what it actually says (FV2-3).
 * Owns: fetchArticle() (follow redirects, read the page, extract the text, judge whether the page may
 *   be shown inside the app), Google News link resolution, and extractArticleText().
 * Notes: The summary is built ONLY from what this returns, so when a page cannot be read the story
 *   loses that source rather than being padded from a headline. Google News RSS links are not the
 *   article: they point at a Google page that forwards to it. Old-style ids carry the real URL in
 *   base64 and are decoded locally; newer ids are resolved the way Google's own page does it
 *   (a signed batchexecute call). Both are best-effort and fall back to nothing.
 */

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

import { ARTICLE_FETCH_TIMEOUT_MS, PRESS_BOX_USER_AGENT } from './httpClient';

const UA = PRESS_BOX_USER_AGENT;
export { ARTICLE_FETCH_TIMEOUT_MS } from './httpClient';
const MAX_HTML_CHARS = 1_000_000;
export const MAX_ARTICLE_CHARS = 6000;
export const MIN_ARTICLE_CHARS = 500;

export interface FetchedArticle {
  url: string;
  text: string;
  embeddable: boolean;
}

async function timedFetch(fetcher: Fetcher, url: string, init: RequestInit = {}, timeoutMs = ARTICLE_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { redirect: 'follow', ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function isGoogleNewsLink(url: string): boolean {
  try {
    return new URL(url).hostname === 'news.google.com';
  } catch {
    return false;
  }
}

function googleArticleId(url: string): string | null {
  const match = /\/(?:rss\/)?articles\/([^/?#]+)/.exec(url);
  return match ? match[1] : null;
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Old-style Google News ids embed the destination: a protobuf-ish blob with a plain http(s) URL in it. */
export function decodeEmbeddedGoogleUrl(id: string): string | null {
  const bytes = base64UrlToBytes(id);
  if (!bytes) return null;
  const text = new TextDecoder('latin1').decode(bytes);
  const match = /https?:\/\/[\x21-\x7e]+/.exec(text);
  if (!match) return null;
  const url = match[0].replace(/[^\x21-\x7e].*$/, '');
  // New-style ids start with an "AU_yq" marker and carry no URL; a hit there would be garbage.
  return /^https?:\/\/[^/]+\.[a-z]{2,}/i.test(url) ? url : null;
}

/** New-style ids: ask Google's own endpoint, as the news.google.com page does. Returns null on any failure. */
async function resolveViaBatchExecute(id: string, fetcher: Fetcher): Promise<string | null> {
  try {
    const page = await timedFetch(fetcher, `https://news.google.com/rss/articles/${id}`, { headers: { 'user-agent': UA } });
    const html = await page.text();
    const signature = /data-n-a-sg="([^"]+)"/.exec(html)?.[1];
    const timestamp = /data-n-a-ts="([^"]+)"/.exec(html)?.[1];
    if (!signature || !timestamp) return null;
    const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${timestamp},"${signature}"]`;
    const body = `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]))}`;
    const res = await timedFetch(fetcher, 'https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': UA },
      body,
    });
    const text = await res.text();
    const match = /garturlres\\",\\"(https?:[^"\\]+)/.exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** The real article URL behind a Google News link, or null when it cannot be resolved. */
export async function resolveGoogleNewsLink(url: string, fetcher: Fetcher): Promise<string | null> {
  const id = googleArticleId(url);
  if (!id) return null;
  return decodeEmbeddedGoogleUrl(id) ?? (await resolveViaBatchExecute(id, fetcher));
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16) || 32))
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code) || 32));
}

function cleanText(html: string): string {
  return decodeBasicEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The readable body of an article page: JSON-LD articleBody, else the paragraphs of <article>/<main>/<body>. */
export function extractArticleText(html: string): string {
  const source = html.slice(0, MAX_HTML_CHARS);
  for (const match of source.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const found = findArticleBody(JSON.parse(match[1]));
      if (found && found.length >= MIN_ARTICLE_CHARS) return cleanText(found).slice(0, MAX_ARTICLE_CHARS);
    } catch {
      // Malformed JSON-LD is common; fall through to the paragraphs.
    }
  }
  const stripped = source.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure)[\s\S]*?<\/\1>/gi, ' ');
  // A page can hold several <article> blocks (ESPN and Yahoo put teasers for other stories in one ahead of the story), so take the
  // <article>/<main> block with the most prose rather than the first one; the whole page is the last resort.
  const blocks = [...(stripped.match(/<article[\s\S]*?<\/article>/gi) ?? []), ...(stripped.match(/<main[\s\S]*?<\/main>/gi) ?? [])].map(proseOf);
  const best = blocks.reduce<string>((most, text) => (text.length > most.length ? text : most), '');
  return (best.length >= MIN_ARTICLE_CHARS ? best : proseOf(stripped)).slice(0, MAX_ARTICLE_CHARS);
}

/** The prose paragraphs of a piece of markup, one per line. */
function proseOf(scope: string): string {
  return Array.from(scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
    .map((match) => cleanText(match[1]))
    // Real prose, not captions, bylines, share buttons or "Subscribe" strips.
    .filter((paragraph) => paragraph.length >= 40 && /[.!?"”]$/.test(paragraph) && !/[{};]\s|function\s*\(|=>/.test(paragraph))
    .join('\n');
}

function findArticleBody(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findArticleBody(entry);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (typeof record.articleBody === 'string') return record.articleBody;
    for (const value of Object.values(record)) {
      const found = findArticleBody(value);
      if (found) return found;
    }
  }
  return null;
}

/** May this page be shown in an iframe? False when it forbids framing (X-Frame-Options, CSP frame-ancestors). */
export function isEmbeddable(headers: Headers): boolean {
  const frameOptions = (headers.get('x-frame-options') ?? '').toLowerCase();
  if (frameOptions.includes('deny') || frameOptions.includes('sameorigin') || frameOptions.includes('allow-from')) return false;
  const csp = headers.get('content-security-policy') ?? '';
  const ancestors = /frame-ancestors([^;]*)/i.exec(csp)?.[1]?.trim();
  if (ancestors !== undefined) {
    return ancestors.split(/\s+/).some((value) => value === '*' || value === 'https:');
  }
  return true;
}

/**
 * Read one article. Resolves Google News links first. Returns null when the page cannot be fetched or
 * has too little text to summarize from.
 */
export async function fetchArticle(link: string, fetcher: Fetcher): Promise<FetchedArticle | null> {
  let url = link;
  if (isGoogleNewsLink(url)) {
    const resolved = await resolveGoogleNewsLink(url, fetcher);
    if (!resolved) return null;
    url = resolved;
  }
  try {
    const res = await timedFetch(fetcher, url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? 'text/html')) return null;
    const html = await res.text();
    const text = extractArticleText(html);
    if (text.length < MIN_ARTICLE_CHARS) return null;
    return { url: res.url || url, text, embeddable: isEmbeddable(res.headers) };
  } catch {
    return null;
  }
}
