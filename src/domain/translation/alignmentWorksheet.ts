import type { FewShotExample } from "./models";

export interface AlignmentBlock {
  itemId: string;
  sourceText: string;
  draftKorean: string;
  precedents: FewShotExample[];
}

function renderBlock(b: AlignmentBlock): string {
  const precedents = b.precedents.map((p) => `- EN: ${p.source}\n  KO: ${p.target}`).join("\n");
  return [`### ${b.itemId}`, "원문:", b.sourceText, "현재 번역:", b.draftKorean, "선례:", precedents, "번역:", ""].join("\n");
}

export function assembleAlignmentWorksheet(blocks: AlignmentBlock[]): string {
  const header = [
    "# Mantle KR 번역 정렬 (TM alignment)",
    "",
    "아래 각 아이템의 `현재 번역:`을, `선례:`의 EN↔KO 쌍에서 쓰인 표현·용어에 맞게 다듬어 `번역:` 아래에 채워 주세요.",
    "선례가 다루지 않는 부분은 그대로 두고, `---` 스레드 구분자·캐시태그/해시태그/멘션·링크는 보존하세요.",
    "재번역이 아니라 선례에 맞춘 교정입니다.",
    "",
    "---",
    "",
  ].join("\n");
  return header + blocks.map(renderBlock).join("\n");
}
