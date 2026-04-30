/**
 * Subsequence-match scoring for slash-command and similar pickers.
 *
 * Given a query, returns matched candidates in best-first order with all
 * non-matches dropped. A candidate matches when every query character appears
 * in the candidate name in order (not necessarily contiguous). Score rewards
 * contiguous runs, prefix matches, and word-boundary hits so "git" still
 * surfaces "/git" before "/login" when typing "g".
 *
 * Audit U-B3: replaces the prior `startsWith` filter in `src/repl.ts`.
 */

export type FuzzyEntry<T> = T & { name: string };

export type FuzzyResult<T> = { entry: FuzzyEntry<T>; score: number };

/**
 * Score a single candidate against the query. Returns `null` when query is not
 * a subsequence of name. Higher scores are better.
 *
 * Scoring rubric (additive):
 *  +100  candidate name starts with query (still earns subsequence bonus on top)
 *  +50   per character of contiguous run (max once per matched char pair)
 *  +20   match on a word-boundary char (after `-`, `_`, ` `, ':' or at start)
 *  +1    base per matched character
 *  -1    per skipped (unmatched) character before final query char
 */
export function fuzzyScore(query: string, name: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const n = name.toLowerCase();

  let qi = 0;
  let score = 0;
  let lastMatchIdx = -2;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) {
      score += 1;
      const isBoundary = i === 0 || /[-_ :./]/.test(n[i - 1]!);
      if (isBoundary) score += 20;
      if (i === lastMatchIdx + 1) score += 50;
      lastMatchIdx = i;
      qi++;
    }
  }
  if (qi < q.length) return null;

  // Prefix bonus: candidate begins with the full query verbatim.
  if (n.startsWith(q)) score += 100;
  // Penalty for skipped chars between first and last match.
  const span = lastMatchIdx - (n.indexOf(q[0]!) ?? 0);
  if (span > q.length) score -= span - q.length;
  return score;
}

/**
 * Filter and rank entries by `entry.name` against `query`. Stable for ties:
 * preserves the original input order so registration-order categories stay
 * naturally contiguous when scores are equal.
 */
export function fuzzyFilter<T extends { name: string }>(query: string, entries: T[]): FuzzyResult<T>[] {
  const out: FuzzyResult<T>[] = [];
  for (const entry of entries) {
    const score = fuzzyScore(query, entry.name);
    if (score === null) continue;
    out.push({ entry: entry as FuzzyEntry<T>, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
