import type { ProposedPair } from "./pairing";

export interface ProposedRecord extends ProposedPair {
  accept: boolean;
}

export function toProposedRecords(pairs: ProposedPair[]): ProposedRecord[] {
  return pairs.map((p) => ({ ...p, accept: true }));
}

export function renderPairsReview(pairs: ProposedPair[]): string {
  if (pairs.length === 0) return "# TM 페어링 검토\n\n제안된 쌍 없음.\n";
  const blocks = pairs.map((p, i) =>
    [
      `## ${i + 1}. ${p.enId} ↔ ${p.koId}  (score ${p.score}: ${p.shared.join(", ")})`,
      "",
      "**EN (원문):**",
      "",
      p.source,
      "",
      "**KO (완성본):**",
      "",
      p.target,
      "",
    ].join("\n"),
  );
  return [
    `# TM 페어링 검토 — ${pairs.length}쌍`,
    "",
    '> 틀린 쌍은 pairs-proposed.json에서 "accept"를 false로 바꾼 뒤 `pnpm tm:promote`.',
    "",
    blocks.join("---\n\n"),
  ].join("\n");
}
