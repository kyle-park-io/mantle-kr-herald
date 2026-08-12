import { typeLabel, type ConversionType } from "../conversion/models";
import type { GlossaryEntry } from "../translation/models";
import { renderGlossaryEntry } from "../translation/promptAssembler";
import { DESTINATIONS_BY_CHANNEL, emit } from "./emitters";
import { KAKAO_FOLD } from "./emitters/kakao";
import { TELEGRAM_MAX } from "./emitters/telegram";
import { ALL_CHANNELS, type Channel } from "./models";
import { TCO_LENGTH, X_MAX_WEIGHTED } from "./weightedLength";
import { appendXLinkCta, needsXLinkCta, xLinkCta } from "./xLinkCta";

/**
 * A stand-in X post url, used only to *measure* a 공지 draft — never shown, never copied.
 *
 * Deliberately **not** `X_URL_PENDING`. That placeholder is 10 characters and exists so a [복사]
 * preview taken before the post is up cannot be pasted as a working url; measuring with it would
 * leave the worksheet under-reporting by ~40 characters, which is the very failure this measurement
 * is here to remove. A real url is what ships, so a real url's *length* is what has to be counted:
 * this is `postUrl(handle, rootId)`'s shape (`src/domain/publish/xReconcile.ts`) with the KR handle
 * and a 19-digit snowflake id, i.e. the longest form a KR post url actually takes.
 */
const X_URL_SAMPLE = "https://x.com/0xMantleKR/status/2087418810458382585";

/** What the CTA costs a draft, for the note in `constraintLine`: the blank line plus the CTA line. */
const X_LINK_CTA_LENGTH = [...appendXLinkCta("", xLinkCta("kakao", X_URL_SAMPLE))].length;

export interface RefinementDraft {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  draft: string;
}

const HOW_TO = [
  "## 쓰는 법",
  "- 볼드는 `**이렇게**`, 링크는 `[텍스트](URL)`로 씁니다. 목적지별 문법 변환은 코드가 합니다.",
  "- x 채널에서 **빈 줄 두 개 = 트윗 경계**입니다.",
  "- 한 줄에 `---`만 있어도 트윗 경계로 인식됩니다.",
  "- 유니코드 볼드(𝗔)는 쓰지 마세요 — 스크린리더가 단어를 통째로 건너뜁니다.",
].join("\n");

/**
 * The primary destination is the one whose numbers the worksheet reports.
 *
 * A 공지 draft is measured **with the X link CTA appended**, because that is what ships. The CTA is
 * composed at send time rather than stored on the rendering (`xLinkCta`), and both the send path
 * and the board's [복사] preview append it before emitting (`apiHandlers.ts:622,636`) — so the board
 * already counts it and only this, the writer-facing surface, did not. Measuring the bare draft let
 * a 460-character `kakao_notice` draft print `460/500` with no warning while the message that
 * reached the room was ~535 and folded behind 「전체보기」. "CTA 포함 500자" is the type's defining
 * rule; the worksheet is where a writer is asked to honour it, so it has to show the number the
 * rule is about.
 */
function report(type: ConversionType, channel: Channel, draft: string, xMaxWeighted: number): string {
  const measured = needsXLinkCta(type, channel) ? appendXLinkCta(draft, xLinkCta(channel, X_URL_SAMPLE)) : draft;
  const { segments } = emit(measured, DESTINATIONS_BY_CHANNEL[channel][0], xMaxWeighted);
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

/** Static for every channel except x, whose limit depends on the account (see xMaxWeighted). */
function constraintLine(channel: Channel, xMaxWeighted: number): string {
  if (channel === "x") return `- x: 트윗당 ${xMaxWeighted} 가중치 (**한글·이모지는 2**, 그 외 1, URL은 길이 무관 ${TCO_LENGTH})`;
  return {
    telegram: `- telegram: 메시지당 ${TELEGRAM_MAX}자`,
    kakao: `- kakao: **${KAKAO_FOLD}자 초과 시 말풍선이 「전체보기」로 접힙니다** — 카카오는 언제나 한 통으로 나가니 나눠서 해결할 수 없고, 줄이는 수밖에 없습니다. 공지 초안의 글자 수에는 발송 시 자동으로 붙는 X 링크 CTA(${X_LINK_CTA_LENGTH}자)가 이미 포함돼 있습니다.`,
    pr_mail: `- pr_mail: 첫 줄이 제목`,
  }[channel];
}

export function assembleRefinementWorksheet(drafts: RefinementDraft[], glossary: GlossaryEntry[], xMaxWeighted: number = X_MAX_WEIGHTED): string {
  const present = new Set(drafts.map((d) => d.channel));
  const channels = ALL_CHANNELS.filter((c) => present.has(c));
  const constraints = ["## 채널 제약", ...channels.map((c) => constraintLine(c, xMaxWeighted))].join("\n");
  const glossaryBlock = glossarySection(glossary, drafts.map((d) => d.draft).join("\n"));

  const blocks = drafts.map((d) =>
    [
      `## ${d.itemId} · ${typeLabel(d.type)} · ${d.channel}`,
      report(d.type, d.channel, d.draft, xMaxWeighted),
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
