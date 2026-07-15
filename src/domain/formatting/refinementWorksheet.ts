import { typeLabel, type ConversionType } from "../conversion/models";
import type { Channel } from "./models";

export interface RefinementDraft {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  draft: string;
}

export function assembleRefinementWorksheet(drafts: RefinementDraft[]): string {
  const blocks = drafts.map((d) =>
    [`## ${d.itemId} · ${typeLabel(d.type)} · ${d.channel}`, "초안:", d.draft, "보정:", ""].join("\n"),
  );
  return [
    "# Mantle KR 채널 포매팅 보정 작업",
    "",
    "아래 각 블록의 `초안:`(코드 포매터 결과)을 채널 특성에 맞게 다듬어 `보정:` 아래에 채워 주세요.",
    "",
    ...blocks,
  ].join("\n");
}
