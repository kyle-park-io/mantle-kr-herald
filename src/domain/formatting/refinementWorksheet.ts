import { typeLabel, type ConversionType } from "../conversion/models";
import type { GlossaryEntry } from "../translation/models";
import { renderGlossaryEntry } from "../translation/promptAssembler";
import { DESTINATIONS_BY_CHANNEL, emit } from "./emitters";
import { KAKAO_FOLD } from "./emitters/kakao";
import { TELEGRAM_MAX } from "./emitters/telegram";
import { ALL_CHANNELS, type Channel } from "./models";
import { TCO_LENGTH, X_MAX_WEIGHTED } from "./weightedLength";

export interface RefinementDraft {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  draft: string;
}

/** Generated from the emitters' own constants, so the worksheet can never drift from the code. */
const CONSTRAINT: Record<Channel, string> = {
  x: `- x: 트윗당 ${X_MAX_WEIGHTED} 가중치 (**한글·이모지는 2**, 그 외 1, URL은 길이 무관 ${TCO_LENGTH})`,
  telegram: `- telegram: 메시지당 ${TELEGRAM_MAX}자`,
  kakao: `- kakao: **${KAKAO_FOLD}자 초과 시 말풍선이 「전체보기」로 접힙니다**`,
  pr_mail: `- pr_mail: 첫 줄이 제목`,
};

const HOW_TO = [
  "## 쓰는 법",
  "- 볼드는 `**이렇게**`, 링크는 `[텍스트](URL)`로 씁니다. 목적지별 문법 변환은 코드가 합니다.",
  "- x 채널에서 **빈 줄 두 개 = 트윗 경계**입니다.",
  "- 한 줄에 `---`만 있어도 트윗 경계로 인식됩니다.",
  "- 유니코드 볼드(𝗔)는 쓰지 마세요 — 스크린리더가 단어를 통째로 건너뜁니다.",
].join("\n");

/** The primary destination is the one whose numbers the worksheet reports. */
function report(channel: Channel, draft: string): string {
  const { segments } = emit(draft, DESTINATIONS_BY_CHANNEL[channel][0]);
  return segments
    .map((s) => {
      const mark = s.overLimit ? "⚠ " : "";
      const where = s.label ? `${s.label} — ` : "";
      const over = s.overLimit ? ` (${s.length - s.limit} 초과)` : "";
      return `${mark}${where}**${s.length}/${s.limit}**${over}`;
    })
    .join("\n");
}

/** Escapes regex metacharacters so a glossary term can be dropped verbatim into a pattern. */
function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A term matches only when it is not flanked by an ASCII alphanumeric character on either side —
 * plain substring search produces false positives (e.g. glossary term "UR" matching inside
 * "Mantle Index Fo**ur**", "DEX" matching inside "Mantle In**dex** Four"). Korean characters are
 * not ASCII alphanumerics, so a term adjacent to Hangul (e.g. "$MNT입니다") still matches, which is
 * intended: Korean loanwords are written with no space before the following particle.
 */
function isTermPresent(term: string, haystack: string): boolean {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, "i");
  return pattern.test(haystack);
}

function glossarySection(glossary: GlossaryEntry[], allDrafts: string): string | undefined {
  const used = glossary.filter((e) => isTermPresent(e.term, allDrafts));
  if (used.length === 0) return undefined;
  return ["## 용어집 (초안에 등장하는 것만)", ...used.map(renderGlossaryEntry)].join("\n");
}

export function assembleRefinementWorksheet(drafts: RefinementDraft[], glossary: GlossaryEntry[]): string {
  const present = new Set(drafts.map((d) => d.channel));
  const channels = ALL_CHANNELS.filter((c) => present.has(c));
  const constraints = ["## 채널 제약", ...channels.map((c) => CONSTRAINT[c])].join("\n");
  const glossaryBlock = glossarySection(glossary, drafts.map((d) => d.draft).join("\n"));

  const blocks = drafts.map((d) =>
    [
      `## ${d.itemId} · ${typeLabel(d.type)} · ${d.channel}`,
      report(d.channel, d.draft),
      "",
      "초안:",
      d.draft,
      "보정:",
      "",
    ].join("\n"),
  );

  return [
    "# Mantle KR 채널 포매팅 보정 작업",
    "",
    HOW_TO,
    "",
    constraints,
    "",
    ...(glossaryBlock ? [glossaryBlock, ""] : []),
    ...blocks,
  ].join("\n");
}
