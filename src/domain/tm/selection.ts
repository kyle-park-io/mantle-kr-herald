import type { ContentItem } from "../translation/contentItem";
import type { FewShotExample } from "../translation/models";
import { extractAnchors, sharedAnchors } from "./anchors";

function selectByAnchors(targetAnchors: string[], tm: FewShotExample[], k: number): FewShotExample[] {
  return tm
    .map((ex) => ({ ex, score: sharedAnchors(extractAnchors(ex.source), targetAnchors).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score) // stable in V8: equal scores keep input order
    .slice(0, k)
    .map((s) => s.ex);
}

export function selectRelevantTm(batch: ContentItem[], tm: FewShotExample[], k: number): FewShotExample[] {
  const batchAnchors = [...new Set(batch.flatMap((i) => extractAnchors(i.text)))];
  return selectByAnchors(batchAnchors, tm, k);
}

export function selectPrecedents(sourceText: string, tm: FewShotExample[], k: number): FewShotExample[] {
  return selectByAnchors(extractAnchors(sourceText), tm, k);
}
