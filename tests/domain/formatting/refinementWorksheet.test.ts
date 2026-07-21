import { describe, it, expect } from "vitest";
import { assembleRefinementWorksheet } from "../../../src/domain/formatting/refinementWorksheet";
import { emitTelegramBot, emitTelegramPaste } from "../../../src/domain/formatting/emitters/telegram";

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
