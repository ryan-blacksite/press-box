/**
 * Purpose: the guardrails every AI-written Press Box story must pass before it is stored (FV2-3, moved out of the
 *   Worker into the writer job with FV2-16).
 * Owns: SummaryResult, MAX_QUOTED_RUN_WORDS, sentenceCount(), longestSharedRun(), unsupportedNumbers(),
 *   talksAboutTheArticle() and validateSummary().
 * Notes: The prompt (ai.ts) is a request; this is the check. A summary is dropped, not published, if it has a number
 *   the articles never mention, copies the article at length, or is the wrong length. A dropped summary is asked for
 *   once more with the objections, and then the story falls back to the feed's own headline and snippet. Pure functions:
 *   no network, no clock.
 *   FV2-154 item 6a: a summary states what happened and nothing else. Sentences ABOUT the article ("The article does not specify
 *   the next opponent") are filler a model writes when it is made to fill a sentence count, so the count is 2 to 6 (never pad) and
 *   talksAboutTheArticle() rejects them. The test is on the present-tense "does not specify" family, not "did not say": news
 *   reports that a team "did not disclose terms", and that is a fact, not talk about the page.
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
const NUMBER_WORDS: Record<string, string> = { '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten', '11': 'eleven', '12': 'twelve', '13': 'thirteen', '14': 'fourteen', '15': 'fifteen', '16': 'sixteen', '17': 'seventeen', '18': 'eighteen', '19': 'nineteen', '20': 'twenty', '30': 'thirty', '40': 'forty', '50': 'fifty' };

export function unsupportedNumbers(summary: string, articles: string[]): string[] {
  const haystack = articles.join(' ').replace(/,/g, '');
  const spelledOut = (number: string) => NUMBER_WORDS[number] !== undefined && new RegExp(`\\b${NUMBER_WORDS[number]}\\b`, 'i').test(haystack);
  const found = summary.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? [];
  return Array.from(new Set(found)).filter((number) => !spelledOut(number) && !new RegExp(`(^|[^\\d.])${number.replace('.', '\\.')}([^\\d]|$)`).test(haystack));
}

/** Words that make a claim of their own ("second straight win", "first loss", "back-to-back"): each must be in the articles if the summary uses it. */
const CLAIM_WORDS = /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|back-to-back|consecutive|straight|in a row|undefeated|unbeaten|winless|sweep|swept|record-breaking|franchise record|career-high|season-high|walk-off|shutout|comeback)\b/gi;

/** Capitalized words that are not names: days, months, and words a sentence can carry without being a person or team. */
const NOT_NAMES = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'according', 'coach', 'head', 'general', 'manager', 'league', 'season', 'conference', 'division', 'playoffs', 'playoff', 'overtime', 'american', 'national', 'eastern', 'western', 'central']);

function plain(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").replace(/'s\b/g, '').replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ');
}

/** Claim words the summary uses that no article uses ("second loss in as many games" from an article about a first loss). */
export function unsupportedClaims(summary: string, articles: string[]): string[] {
  const haystack = plain(articles.join(' '));
  const found = (summary.match(CLAIM_WORDS) ?? []).map((word) => plain(word).trim());
  return Array.from(new Set(found)).filter((word) => !haystack.includes(word));
}

/**
 * Names the summary uses that no article uses. A name is a capitalized word that is not the first word of a sentence. Possessives and
 * accents are folded, so "Cardinals'" is "Cardinals" and "Dončić" is "doncic".
 */
export function unsupportedNames(summary: string, articles: string[]): string[] {
  const haystack = plain(articles.join(' '));
  const names = new Set<string>();
  for (const sentence of summary.split(/(?<=[.!?])\s+/)) {
    const tokens = sentence.split(/\s+/);
    // The first word of a sentence is capitalized anyway, so it counts only as the start of a full name ("Zacc Hartley").
    const start = /^[A-Z]/.test(tokens[1] ?? '') ? 0 : 1;
    for (const raw of tokens.slice(start)) {
      const word = raw.replace(/[’']s?$/, '').replace(/^[^A-Za-z]+|[^A-Za-z-]+$/g, '');
      if (/^[A-Z][a-z]{2,}(?:-[A-Z][a-z]+)?$/.test(word) && !NOT_NAMES.has(word.toLowerCase())) names.add(word);
    }
  }
  return Array.from(names).filter((name) => !haystack.includes(plain(name)));
}

/**
 * Wording that is about the source text rather than the news: "the article", "does not specify", "is not mentioned",
 * "no information". Returns the phrases found, so the retry can name them.
 */
const ABOUT_THE_ARTICLE: [RegExp, string][] = [
  [/\b(?:the|this|these|those|that|an?|said|provided|given)\s+(?:\w+\s+)?(?:articles?|passages?|excerpts?|write-?ups?|blurbs?)\b/i, 'the article'],
  [/\b(?:the|this|these|that|provided|given)\s+(?:source\s+)?(?:text|texts)\s+(?:does|do|did|is|are|was|were|doesn't|don't|didn't|isn't|aren't)\b/i, 'the text'],
  [/\b(?:does|do)\s+not\s+(?:specify|mention|state|say|indicate|clarify|elaborate|provide|detail|reveal)\b/i, 'does not specify'],
  [/\b(?:doesn't|don't)\s+(?:specify|mention|state|say|indicate|clarify|elaborate|provide|detail|reveal)\b/i, 'does not specify'],
  [/\b(?:is|are|was|were|be|been)\s+(?:not|never)\s+(?:mentioned|specified|stated|provided|detailed|addressed|included|given|clear from)\b/i, 'is not mentioned'],
  [/\bno\s+(?:further|additional|more|other|specific)?\s*information\s+(?:is|was|has|have|about|on|regarding|available|provided|given)\b/i, 'no information'],
  [/\bno\s+(?:further|additional|more|other)\s+details?\s+(?:is|was|are|were|has|have|available|provided|given|mentioned|specified)\b/i, 'no information'],
  [/\bnot\s+(?:enough|sufficient)\s+(?:information|details?)\b/i, 'no information'],
  [/\b(?:left|remains?)\s+(?:unspecified|unstated|unmentioned)\b/i, 'is not mentioned'],
];

export function talksAboutTheArticle(text: string): string[] {
  const found = new Set<string>();
  for (const [pattern, label] of ABOUT_THE_ARTICLE) if (pattern.test(text)) found.add(label);
  return Array.from(found);
}

export function validateSummary(result: SummaryResult, articles: string[]): string[] {
  const problems: string[] = [];
  const sentences = sentenceCount(result.summary);
  if (sentences < 2 || sentences > 6) problems.push(`it has ${sentences} sentences; it must have 2 to 6`);
  if (result.summary.length > 1200) problems.push('it is too long');
  if (!result.headline.trim() || result.headline.length > 140) problems.push('the headline is missing or too long');
  const run = longestSharedRun(result.summary, articles);
  if (run >= MAX_QUOTED_RUN_WORDS) problems.push(`it copies ${run} words in a row from an article; rewrite it in your own words`);
  const talk = talksAboutTheArticle(`${result.headline} ${result.summary}`);
  if (talk.length > 0) problems.push(`it talks about the article or what it leaves out ("${talk.join('", "')}"); state only what happened and delete any sentence about what the text does not say`);
  const numbers = unsupportedNumbers(`${result.headline} ${result.summary}`, articles);
  if (numbers.length > 0) problems.push(`it states ${numbers.join(', ')}, which the articles do not say; remove anything not in the text`);
  // Facts must match the articles: claim words ("second straight", "undefeated") and names, as numbers above.
  const claims = unsupportedClaims(`${result.headline} ${result.summary}`, articles);
  if (claims.length > 0) problems.push(`it says "${claims.join('", "')}", which the articles do not; remove or correct it`);
  const names = unsupportedNames(result.summary, articles);
  if (names.length > 0) problems.push(`it names ${names.join(', ')}, which the articles do not mention; use only names in the text`);
  return problems;
}
