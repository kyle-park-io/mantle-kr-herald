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
    // Bold that opened before a post boundary and closed after it (see splitPosts) leaves each
    // half with an unbalanced **, which stripBold cannot repair per-post — warn instead of
    // silently leaking literal asterisks into the tweet.
    if (text.includes("**")) {
      const where = posts.length > 1 ? `트윗 ${i + 1}/${posts.length}: ` : "";
      warnings.push(`${where}볼드(**)가 트윗 경계를 넘어가 있어 짝이 맞지 않습니다`);
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
