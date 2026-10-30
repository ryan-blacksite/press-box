/**
 * Purpose: the guardrails every AI-written Press Box story must pass before it is stored (FV2-3, moved out of the
 *   Worker into the writer job with FV2-16).
 * Owns: SummaryResult, MAX_QUOTED_RUN_WORDS, sentenceCount(), longestSharedRun(), unsupportedNumbers() and
 *   validateSummary().
 * Notes: The prompt (ai.ts) is a request; this is the check. A summary is dropped, not published, if it has a number
 *   the articles never mention, copies the article at length, or is the wrong length. A dropped summary is asked for
 *   once more with the objections, and then the story falls back to the feed's own headline and snippet. Pure functions:
 *   no network, no clock.
 */

export interface SummaryResult {
  headline: string;
  summary: string;
}

const MAX_QUOTED_RUN_WORDS = 10;

function normalizeWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
}

export function sentenceCount(text: string): number {
  return (text.replace(/\b(Mr|Mrs|Ms|Dr|St|vs|No|U\.S|Jr|Sr)\./g, '$1').match(/[^.!?]+[.!?]+(\s|$)/g) ?? []).length;
}

/** The longest run of words the summary shares, in order, with any article. */
export function longestSharedRun(summary: string, articles: string[]): number {
  const words = normalizeWords(summary);
  let best = 0;
  for (const article of articles) {
    const articleWords = normalizeWords(article);
    const index = new Set<string>();
    for (let i = 0; i + MAX_QUOTED_RUN_WORDS <= articleWords.length; i += 1) index.add(articleWords.slice(i, i + MAX_QUOTED_RUN_WORDS).join(' '));
    for (let start = 0; start + MAX_QUOTED_RUN_WORDS <= words.length; start += 1) {
      if (!index.has(words.slice(start, start + MAX_QUOTED_RUN_WORDS).join(' '))) continue;
      // Extend the match to find the true length of this run.
      let length = MAX_QUOTED_RUN_WORDS;
      const articleText = articleWords.join(' ');
      while (start + length < words.length && articleText.includes(words.slice(start, start + length + 1).join(' '))) length += 1;
      best = Math.max(best, length);
    }
  }
  return best;
}

/** Every number in the summary must appear in the articles ("27-24", "$40 million", "3"). Words like "one" are ignored. */
export function unsupportedNumbers(summary: string, articles: string[]): string[] {
  const haystack = articles.join(' ').replace(/,/g, '');
  const found = summary.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? [];
  return Array.from(new Set(found)).filter((number) => !new RegExp(`(^|[^\\d.])${number.replace('.', '\\.')}([^\\d]|$)`).test(haystack));
}

export function validateSummary(result: SummaryResult, articles: string[]): string[] {
  const problems: string[] = [];
  const sentences = sentenceCount(result.summary);
  if (sentences < 4 || sentences > 6) problems.push(`it has ${sentences} sentences; it must have 4 to 6`);
  if (result.summary.length > 1200) problems.push('it is too long');
  if (!result.headline.trim() || result.headline.length > 140) problems.push('the headline is missing or too long');
  const run = longestSharedRun(result.summary, articles);
  if (run >= MAX_QUOTED_RUN_WORDS) problems.push(`it copies ${run} words in a row from an article; rewrite it in your own words`);
  const numbers = unsupportedNumbers(`${result.headline} ${result.summary}`, articles);
  if (numbers.length > 0) problems.push(`it states ${numbers.join(', ')}, which the articles do not say; remove anything not in the text`);
  return problems;
}
