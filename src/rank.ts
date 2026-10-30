/**
 * Purpose: turn a pile of headlines into "stories": de-duplicate the same news told by several
 *   outlets, then rank by how big it is (FV2-3).
 * Owns: clusterItems() and rankClusters().
 * Notes: "Biggest" is judged only from what feeds tell us: how many different outlets carried the
 *   story (the strongest signal), how fresh it is, and a small nudge for ESPN and the team's own
 *   site. Two headlines are the same story when their significant words overlap enough; each
 *   headline joins the first cluster it matches, so the result does not depend on randomness.
 */
import type { FeedItem } from './shared/types';

export interface Cluster {
  items: FeedItem[];
  /** Distinct outlets in the cluster. */
  outlets: string[];
  newestAt: number;
  score: number;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were',
  'be', 'will', 'after', 'over', 'into', 'his', 'her', 'their', 'its', 'this', 'that', 'vs', 'says', 'say', 'report', 'reports',
]);

export function titleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  return new Set(words);
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  a.forEach((word) => {
    if (b.has(word)) shared += 1;
  });
  // Overlap relative to the SHORTER headline: a terse headline restating a longer one is a match.
  return shared / Math.min(a.size, b.size);
}

export const SAME_STORY_THRESHOLD = 0.6;

export function clusterItems(items: FeedItem[]): Cluster[] {
  const clusters: { items: FeedItem[]; tokens: Set<string>[] }[] = [];
  // Newest first, so a cluster's lead is its freshest headline.
  const ordered = [...items].sort((a, b) => b.publishedAt - a.publishedAt);
  for (const item of ordered) {
    const tokens = titleTokens(item.title);
    const home = clusters.find((cluster) => cluster.tokens.some((other) => similarity(tokens, other) >= SAME_STORY_THRESHOLD));
    if (home) {
      home.items.push(item);
      home.tokens.push(tokens);
    } else {
      clusters.push({ items: [item], tokens: [tokens] });
    }
  }
  return clusters.map((cluster) => {
    const outlets = Array.from(new Set(cluster.items.map((item) => item.source)));
    return { items: cluster.items, outlets, newestAt: Math.max(...cluster.items.map((item) => item.publishedAt)), score: 0 };
  });
}

/** Biggest first. `now` is passed in so ranking is a pure function. */
export function rankClusters(clusters: Cluster[], now: number): Cluster[] {
  const scored = clusters.map((cluster) => {
    const ageHours = cluster.newestAt > 0 ? Math.max(0, (now - cluster.newestAt) / 3_600_000) : 72;
    const freshness = Math.max(0, 4 - ageHours / 18); // 4 points when brand new, 0 after ~3 days
    const breadth = Math.min(cluster.outlets.length, 6) * 3;
    const trusted = cluster.items.some((item) => item.feed === 'espn' || item.feed === 'team') ? 1 : 0;
    return { ...cluster, score: breadth + freshness + trusted };
  });
  return scored.sort((a, b) => b.score - a.score || b.newestAt - a.newestAt);
}
