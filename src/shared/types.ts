/**
 * Purpose: shared shapes for the Press Box: the read-only Worker (FV2-3) and the daily writer job that fills
 *   its store (scripts/press-box, FV2-16).
 * Owns: Env (the Worker's bindings), FeedItem (one headline from a feed), Story and TeamStories (the KV value
 *   the writer stores and the app reads).
 * Notes: Everything the app receives is a Story: the summary plus the outlets it was built from, named in plain
 *   text, and where to read the original. No field carries article text; the writer uses it to write the summary
 *   and discards it. The Worker calls no AI: it only reads what the writer stored.
 */

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface Env {
  /** Per-team story store. Written by the daily GitHub Actions job (scripts/press-box), read here. */
  PRESS_BOX_KV: KVNamespaceLike;
  /** Comma-separated exact-match origins allowed to read (the app, the native shells, the Arena demo). */
  ALLOWED_ORIGIN: string;
}

/** One headline from a feed, before it is clustered or summarized. */
export interface FeedItem {
  title: string;
  link: string;
  /** Epoch ms; 0 when the feed gave no usable date. */
  publishedAt: number;
  /** The outlet's name ("ESPN", "Detroit Free Press"). */
  source: string;
  /** The feed's own blurb, tags stripped. Never used as a summary on its own. */
  description: string;
  /** Which feed it came from, for logs and tie-breaks. */
  feed: 'google' | 'espn' | 'team' | 'league';
}

export interface StorySource {
  name: string;
  url: string;
}

export interface Story {
  id: string;
  headline: string;
  /** 4-6 sentences, our own words. */
  summary: string;
  /** Outlets whose article text the summary was built from. */
  sources: StorySource[];
  /** The article to open ("Read the full story"): the best-sourced one. */
  url: string;
  /** True when that page allows being shown in an iframe (the app falls back to a new tab if not). */
  embeddable: boolean;
  /** ISO time the newest article in the story was published. */
  publishedAt: string;
}

export interface TeamStories {
  teamId: string;
  /** ISO time these stories were built. */
  updatedAt: string;
  stories: Story[];
}
