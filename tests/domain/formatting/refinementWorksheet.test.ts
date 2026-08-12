import { describe, it, expect } from "vitest";
import { assembleRefinementWorksheet } from "../../../src/domain/formatting/refinementWorksheet";
import { emitKakaoPaste } from "../../../src/domain/formatting/emitters/kakao";
import { emitTelegramBot, emitTelegramPaste } from "../../../src/domain/formatting/emitters/telegram";
import { appendXLinkCta, xLinkCta, X_URL_PENDING } from "../../../src/domain/formatting/xLinkCta";

describe("assembleRefinementWorksheet", () => {
  it("emits a header and one block per draft with 초안 and an empty 보정 slot", () => {
    const out = assembleRefinementWorksheet(
      [
        { itemId: "x:1", type: "x", channel: "x", draft: "X 초안 텍스트" },
        { itemId: "x:1", type: "kol", channel: "telegram", draft: "*텔레그램*" },
      ],
      [],
    );
    expect(out).toContain("보정");
    expect(out).toContain("## x:1 · X · x");
    expect(out).toContain("X 초안 텍스트");
    expect(out).toContain("## x:1 · KOL · telegram");
    expect(out).toContain("초안:");
    expect(out.trimEnd().endsWith("보정:")).toBe(true);
  });

  it("orders channel constraint bullets by ALL_CHANNELS, not by draft/approval order", () => {
    const out = assembleRefinementWorksheet(
      [
        { itemId: "x:1", type: "pr", channel: "pr_mail", draft: "메일" },
        { itemId: "x:1", type: "kol", channel: "telegram", draft: "텔레그램" },
        { itemId: "x:1", type: "x", channel: "x", draft: "엑스" },
      ],
      [],
    );
    const constraints = out.split("## 채널 제약")[1].split("\n\n")[0];
    expect(constraints.indexOf("- x:")).toBeLessThan(constraints.indexOf("- telegram:"));
    expect(constraints.indexOf("- telegram:")).toBeLessThan(constraints.indexOf("- pr_mail:"));
  });

  it("reports telegram_paste's number for a telegram draft with a link, not telegram_bot's", () => {
    // A link makes the two telegram destinations diverge: paste spells it out as "text (url)",
    // bot keeps only the label and drops the url from the visible count entirely.
    const draft = "공지 [자세히](https://x.io)";
    const paste = emitTelegramPaste(draft).segments[0];
    const bot = emitTelegramBot(draft).segments[0];
    // Sanity check: this test only proves anything if the two destinations actually disagree.
    expect(paste.length).not.toBe(bot.length);

    const out = assembleRefinementWorksheet([{ itemId: "x:1", type: "kol", channel: "telegram", draft }], []);
    expect(out).toContain(`**${paste.length}/${paste.limit}**`);
    expect(out).not.toContain(`**${bot.length}/${bot.limit}**`);
  });
});

/**
 * The number a writer is asked to hit has to be the number that ships.
 *
 * The 공지 CTA is composed at send time rather than stored on the rendering, so the draft in front of
 * the writer is ~75 characters shorter than the message the room receives. The board already counts
 * it (`withXLinkCta` runs before `emitAll`); before this, the worksheet did not — and "CTA 포함
 * 500자" is the whole rule for 카톡 공지.
 */
describe("assembleRefinementWorksheet — the 공지 CTA counts against the limit", () => {
  /** Same shape as a real KR post url — `report`'s stand-in has to be this long to be honest. */
  const X_URL = "https://x.com/0xMantleKR/status/2087418810458382585";
  const kakaoNotice = (draft: string) => [{ itemId: "x:1", type: "kakao_notice" as const, channel: "kakao" as const, draft }];

  it("flags a 460자 카톡 공지 draft, because 500자 is the limit on draft + CTA", () => {
    const draft = "가".repeat(460);
    // Sanity: this is exactly the draft the old measurement passed clean.
    expect(emitKakaoPaste(draft).segments[0].overLimit).toBe(false);
    const shipped = emitKakaoPaste(appendXLinkCta(draft, xLinkCta("kakao", X_URL))).segments[0];
    expect(shipped.overLimit).toBe(true);

    const out = assembleRefinementWorksheet(kakaoNotice(draft), []);

    expect(out).toContain(`⚠ **${shipped.length}/500** (${shipped.length - 500} 초과)`);
    expect(out).not.toContain("**460/500**");
  });

  it("measures with a full-length url, not the X 게시 후 채워짐 placeholder", () => {
    // The placeholder is 10 characters against a real url's 51, so measuring with it would leave the
    // same 460자 draft passing clean — under-reporting by ~40 characters instead of ~75.
    const draft = "가".repeat(460);
    const withPlaceholder = emitKakaoPaste(appendXLinkCta(draft, xLinkCta("kakao", X_URL_PENDING))).segments[0];
    expect(withPlaceholder.overLimit).toBe(false);

    const out = assembleRefinementWorksheet(kakaoNotice(draft), []);

    expect(out).not.toContain(`**${withPlaceholder.length}/500**`);
  });

  it("counts it on a telegram 공지 too — the trigger is the CTA, not the channel", () => {
    const draft = "**공지** 본문";
    const shipped = emitTelegramPaste(appendXLinkCta(draft, xLinkCta("telegram", X_URL))).segments[0];

    const out = assembleRefinementWorksheet([{ itemId: "x:1", type: "announcement", channel: "telegram", draft }], []);

    expect(out).toContain(`**${shipped.length}/${shipped.limit}**`);
    expect(out).not.toContain(`**${emitTelegramPaste(draft).segments[0].length}/${shipped.limit}**`);
  });

  it("leaves a draft that carries no CTA measured exactly as written", () => {
    // `--channels kakao` can put any type on kakao; only the 공지 types get a CTA (`needsXLinkCta`),
    // so adding ~75 characters to the rest would be a fabricated overflow.
    const out = assembleRefinementWorksheet([{ itemId: "x:1", type: "casual", channel: "kakao", draft: "가".repeat(460) }], []);

    expect(out).toContain("**460/500**");
    expect(out).not.toContain("⚠");
  });

  it("measures the CTA without showing it — the stand-in url must never be copyable", () => {
    // The worksheet is edited and its 초안 is pasted around; a plausible-looking url in it would
    // eventually reach a live room, which is the reason `X_URL_PENDING` exists in the first place.
    const out = assembleRefinementWorksheet(kakaoNotice("카톡 공지 본문"), []);

    expect(out).not.toContain("x.com");
    expect(out).not.toContain("자세한 내용은 X에서 확인하세요");
    expect(out).toContain("초안:\n카톡 공지 본문");
  });

  it("tells the writer kakao is one message and that the count already includes the CTA", () => {
    const out = assembleRefinementWorksheet(kakaoNotice("본문"), []);
    const kakaoLine = out.split("\n").find((l) => l.startsWith("- kakao:"));

    expect(kakaoLine).toContain("500자");
    expect(kakaoLine).toContain("한 통");
    expect(kakaoLine).toContain("CTA");
  });
});
