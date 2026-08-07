/**
 * Character-level diff between the translation we produced and the copy the account actually
 * published.
 *
 * The published block on the 1차 검수 screen exists so a reviewer can see *what the human changed*,
 * not merely that something did. Measured against production on 2026-08-07,
 * `x:2082149990282207365`'s entire difference was `구매하신 → 구매한` and `무엇입니까 → 무엇인가요` —
 * a register shift the team makes deliberately and `translation/locale.json` forbids. Nobody finds
 * that by eye across twenty-one rows.
 *
 * **Why characters and not words.** This started word-level and it did not work on Korean. Korean is
 * agglutinative, so a small edit replaces the whole whitespace token: `구매하신` and `구매한` share no
 * token at all. Measured over the 21 stored pairs, the word-level diff called 58% and 61% of two
 * genuinely light rewrites "new" and switched their highlighting off entirely — including both items
 * a reviewer had just linked by hand and gone looking at. Per character the same two pairs are 24%
 * and 30%, and **no** stored pair exceeds the give-up threshold. Characters also mark the actual
 * edit (`하신` → `한`) rather than repainting a word that mostly did not change.
 *
 * Only additions are marked. A deletion leaves nothing in the published text to point at, and
 * inventing a marker for one would put text on screen the account never published — this block has
 * to stay a faithful copy of what went out.
 *
 * Not shared with `src/`: the frontend builds on its own tsconfig and cannot import the Node
 * pipeline (the same boundary `web/src/media.ts` documents). Nothing in the pipeline needs this.
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
   * True when so much of the copy is new that highlighting it says nothing, or when the pair is too
   * large to diff at all. The caller renders the published text plain, with a note.
   */
  tooDifferent: boolean;
}

/**
 * Above this share of new characters, highlighting stops being a signal. Half is a deliberately
 * blunt line: the point is to switch off decoration, not to model how heavy an edit "feels".
 */
const TOO_DIFFERENT_AT = 0.5;

/**
 * Cap on each side of the region actually diffed, in characters. The LCS table below is
 * `|middle| x |middle|` cells, so this bounds the work a browser tab does on one render.
 *
 * 4000 is chosen against real content, not intuition: the largest stored pair is a 2,458-character
 * X Article, which diffs in 37ms and turns out to differ by 7 characters. A cap of 1200 would have
 * given up on that pair and reported it as a wholesale rewrite, which is the opposite of true. Only
 * a pair whose *middle* — after the common prefix and suffix are stripped — exceeds this is refused,
 * so the cap is reached only by two long texts that genuinely differ throughout, and rendering those
 * plain is the right answer anyway.
 */
const MAX_DIFF_CHARS = 4000;

/**
 * The longest unchanged gap that gets absorbed into the edit around it, in characters.
 *
 * Found in the browser, not in a test. Rewriting `5,300만 달러에서 92.2억 달러로` as
 * `$53M에서 $9.22B로.` shares digits by coincidence, so a raw LCS marked `$`, `53`, `M` and `에서`
 * as four separate spans with one- and two-character gaps between them: correct, and unreadable —
 * it renders as a row of little boxes rather than as "this passage was rewritten". Three characters
 * is short enough that no real untouched phrase is swallowed (the guard test uses a long untouched
 * middle) and long enough to close the coincidental matches that shatter a rewritten number.
 */
const BRIDGE_GAP = 3;

/**
 * Which indices of `mid` to render as changed: the unmatched ones, plus any run of matched
 * characters short enough to sit *between* two changed runs (see `BRIDGE_GAP`). Leading and
 * trailing matched runs are never bridged — only a gap with an edit on both sides.
 */
function bridged(mid: string[], matched: Set<number>): boolean[] {
  const flags = mid.map((_, k) => !matched.has(k));
  let k = 0;
  while (k < flags.length) {
    if (flags[k]) {
      k++;
      continue;
    }
    let end = k;
    while (end < flags.length && !flags[end]) end++;
    const hasEditBefore = k > 0;
    const hasEditAfter = end < flags.length;
    if (hasEditBefore && hasEditAfter && end - k <= BRIDGE_GAP) {
      for (let i = k; i < end; i++) flags[i] = true;
    }
    k = end;
  }
  return flags;
}

export function diffPublished(draft: string, published: string): PublishedDiff {
  const a = [...draft];
  const b = [...published];
  if (b.length === 0) return { parts: [], tooDifferent: false };

  // Strip the common prefix and suffix before sizing anything. On a light edit this reduces the
  // table to a few characters, which is what keeps a long article cheap.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const parts: DiffPart[] = [];
  /** Append, merging into the previous run when the flag matches, so a rendered edit is one span. */
  const push = (text: string, changed: boolean) => {
    if (text === "") return;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.changed === changed) last.text += text;
    else parts.push({ text, changed });
  };

  if (midA.length > MAX_DIFF_CHARS || midB.length > MAX_DIFF_CHARS) {
    // Too big to diff: still render the whole published text, just unmarked. `tooDifferent` tells
    // the caller to say so rather than leaving a reviewer wondering why nothing is highlighted.
    push(published, false);
    return { parts, tooDifferent: true };
  }

  // Longest common subsequence over the middles, as the set of indices in `midB` that are matched.
  const lengths: Int32Array[] = Array.from({ length: midA.length + 1 }, () => new Int32Array(midB.length + 1));
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lengths[i][j] = midA[i] === midB[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const matched = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      matched.add(j);
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  push(b.slice(0, head).join(""), false);
  for (const [k, ch] of bridged(midB, matched).entries()) push(midB[k], ch);
  push(b.slice(b.length - tail).join(""), false);

  const changedChars = parts.reduce((n, p) => (p.changed ? n + [...p.text].length : n), 0);
  return { parts, tooDifferent: changedChars / b.length > TOO_DIFFERENT_AT };
}
