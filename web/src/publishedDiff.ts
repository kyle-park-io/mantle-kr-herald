/**
 * Word-level diff between the translation we produced and the copy the account actually published.
 *
 * The published block on the 1차 검수 screen exists so a reviewer can see *what the human changed*,
 * not merely that something did. Two paragraphs side by side hide a two-word edit; measured against
 * production on 2026-08-07, the whole difference in `x:2082149990282207365` was `구매하신 → 구매한`
 * and `무엇입니까 → 무엇인가요` — a register shift the team makes deliberately and that our steering
 * config forbids. Nobody finds that by eye across nineteen rows.
 *
 * Only additions are marked. A deletion leaves no token in the published text to point at, and
 * inventing a marker for one would put text on screen the account never published — the published
 * block has to stay a faithful copy of what went out.
 *
 * Not shared with `src/`: the frontend builds on its own tsconfig and cannot import the Node
 * pipeline (same boundary `web/src/media.ts` documents). Nothing in the pipeline needs this.
 */

/** One run of the published text, flagged if the draft did not contain it. */
export interface DiffPart {
  text: string;
  changed: boolean;
}

export interface PublishedDiff {
  /** The published text in order. Concatenating every `text` reproduces it exactly. */
  parts: DiffPart[];
  /**
   * True when so much of the copy is new that highlighting it says nothing. The caller renders the
   * published text plain instead, with a note. Real case: today's lowest reconcile match scored
   * 0.644, i.e. a rewrite that keeps the subject and little else — end-to-end highlight there is
   * decoration, not information.
   */
  tooDifferent: boolean;
}

/**
 * Above this share of new words, highlighting stops being a signal. Half is a deliberately blunt
 * line: the point is to switch off decoration, not to model how heavy an edit "feels", and a
 * threshold anyone can state in one sentence is one a reviewer can trust.
 */
const TOO_DIFFERENT_AT = 0.5;

/**
 * Split into words and the whitespace between them, keeping both. Whitespace runs are carried as
 * their own pieces so the rebuilt text reproduces every newline and double space — the published
 * copy's own line breaks are part of what a reviewer is checking.
 */
function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** Longest common subsequence of two token lists, as the set of indices in `b` that are matched. */
function matchedIndices(a: string[], b: string[]): Set<number> {
  // Classic LCS table. Both inputs are one social post — a few hundred tokens at the very most —
  // so the quadratic table is a few tens of thousands of numbers and never worth optimising.
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const matched = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      matched.add(j);
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matched;
}

export function diffPublished(draft: string, published: string): PublishedDiff {
  const publishedTokens = tokenize(published);
  if (publishedTokens.length === 0) return { parts: [], tooDifferent: false };

  const matched = matchedIndices(tokenize(draft), publishedTokens);

  // Whitespace is never counted as changed and never counted in the ratio: a reviewer cannot act on
  // "the spacing differs", and marking it would paint the gaps between two edited words into one
  // continuous block that overstates the edit.
  let words = 0;
  let newWords = 0;
  const parts: DiffPart[] = [];
  publishedTokens.forEach((text, index) => {
    const isSpace = /^\s+$/.test(text);
    const changed = !isSpace && !matched.has(index);
    if (!isSpace) {
      words++;
      if (changed) newWords++;
    }
    // Merge into the previous part when the flag is unchanged, so a rendered run of edited words is
    // one highlighted span rather than a row of separately boxed tokens.
    const last = parts[parts.length - 1];
    if (last !== undefined && last.changed === changed) last.text += text;
    else parts.push({ text, changed });
  });

  return { parts, tooDifferent: words > 0 && newWords / words > TOO_DIFFERENT_AT };
}
