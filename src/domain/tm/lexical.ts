// A small English function-word set. Dropping these (plus tokens ≤2 chars) keeps lexical similarity
// on the content tokens (tokenized, stocks, liquidity, mantle, …) instead of inflating it with
// "the/of/on". Matching is on the English source both a draft and a TM pair's `source` share.
export const LEXICAL_STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "is", "are", "be", "was", "were", "it", "its", "this", "that", "these", "those",
  "as", "but", "if", "so", "than", "then", "into", "over", "out", "up", "down",
  "you", "your", "we", "our", "they", "their", "has", "have", "had",
  "not", "no", "yes", "can", "will", "just", "now", "all",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !LEXICAL_STOPWORDS.has(t));
}

/** Jaccard similarity of the two texts' content-token sets, in [0, 1]. 0 when either side is empty. */
export function lexicalSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
