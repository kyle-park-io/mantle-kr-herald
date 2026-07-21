import { linksToPlain, splitPosts, stripBold } from "../canonical";
import { X_MAX_WEIGHTED, weightedLength } from "../weightedLength";
import type { EmitResult, EmitSegment } from "./types";

/**
 * X composers take plain text: pasted markdown is not parsed. Unicode "bold" is not a substitute
 * — screen readers skip the styled word entirely, X search does not match it, and every such
 * character costs 2 weighted units. Emphasis belongs in line breaks and structure instead.
 *
 * This never splits an over-limit post. A machine cut lands badly in Korean prose, and a cut made
 * silently here would never be reviewed by anyone; the writer splits, in `pnpm format --refine`.
 */
function emitX(canonical: string): EmitResult {
  const posts = splitPosts(canonical);
  const warnings: string[] = [];

  // Decide, once and on the unsplit text, whether any leftover ** a segment shows below was
  // caused by splitPosts cutting a pair in half, or was already unpaired before the split. If
  // stripBold(canonical) has no ** left, every ** was part of a matched pair, so a segment that
  // still shows ** can only be a half of a pair that straddled a post boundary. If stripBold
  // still leaves a **, the author left one unpaired to begin with, and splitting is unrelated.
  const canonicalWasBalanced = !stripBold(canonical).includes("**");

  const segments: EmitSegment[] = posts.map((post, i) => {
    const text = linksToPlain(stripBold(post));
    const length = weightedLength(text);
    const overLimit = length > X_MAX_WEIGHTED;
    const segment: EmitSegment = { text, length, limit: X_MAX_WEIGHTED, overLimit };
    if (posts.length > 1) segment.label = `트윗 ${i + 1}/${posts.length}`;
    if (overLimit) {
      const where = posts.length > 1 ? `트윗 ${i + 1}/${posts.length}: ` : "";
      warnings.push(`${where}${length}/${X_MAX_WEIGHTED} (${length - X_MAX_WEIGHTED} 초과)`);
    }
    if (text.includes("**")) {
      const where = posts.length > 1 ? `트윗 ${i + 1}/${posts.length}: ` : "";
      warnings.push(
        canonicalWasBalanced
          ? // Bold that opened before a post boundary and closed after it (see splitPosts)
            // leaves each half with an unbalanced **, which stripBold cannot repair per-post.
            `${where}볼드(**)가 트윗 경계를 넘어가 있어 짝이 맞지 않습니다`
          : // No boundary is involved — the ** was already unpaired in the original text, and
            // will otherwise leak into the tweet as literal asterisks.
            `${where}볼드(**)의 짝이 맞지 않아 그대로 노출됩니다`,
      );
    }
    return segment;
  });

  return { segments, warnings };
}

export const emitXPaste = emitX;

/**
 * Typefully's editor is documented to re-split pasted text ("Make thread"), and no first-party
 * source describes a separator that pins our boundaries. Identical to `emitXPaste` until that is
 * verified against the live app — see "Unverified" in the design spec.
 */
export const emitXTypefully = emitX;
