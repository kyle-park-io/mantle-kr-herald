import { describe, it, expect } from "vitest";
import { textVideoBackfillPlanLines } from "../../src/cli/textVideoBackfillReport";
import type { TextVideoBackfillPlan, RenderingTextPatch, TranslationTextPatch } from "../../src/app/BackfillTextVideoUrls";

function plan(overrides: Partial<TextVideoBackfillPlan> = {}): TextVideoBackfillPlan {
  return { scanned: 0, translations: [], renderings: [], skipped: [], filled: 0, ...overrides };
}

function translationPatch(itemId: string, over: Partial<TranslationTextPatch> = {}): TranslationTextPatch {
  return {
    translation: {
      itemId,
      source: "x",
      sourceText: "",
      koreanText: "",
      status: "posted",
      translatedAt: "2026-06-02T00:00:00.000Z",
    },
    columns: ["source_text", "korean_text"],
    filled: 2,
    ...over,
  };
}

function renderingPatch(itemId: string, over: Partial<RenderingTextPatch> = {}): RenderingTextPatch {
  return {
    rendering: {
      itemId,
      type: "x",
      channel: "x",
      text: "",
      refined: false,
      createdAt: "2026-06-03T00:00:00.000Z",
      status: "rendered",
    },
    filled: 1,
    ...over,
  };
}

describe("textVideoBackfillPlanLines", () => {
  it("cannot see whether the run will write", () => {
    // The invariant this file exists for: a preview and a `--yes` run print the SAME plan, so an
    // operator sees the outcome before authorising it. Enforced structurally rather than by
    // eyeballing two runs — the printer takes the plan and nothing else, so there is no mode for it
    // to branch on. A second parameter appearing here is the regression.
    expect(textVideoBackfillPlanLines).toHaveLength(1);
  });

  it("says so plainly when there is nothing to do", () => {
    expect(textVideoBackfillPlanLines(plan()).join("\n")).toContain("no stored text carries a bare [영상]");
  });

  it("states how many texts carry a bare marker and how many rows would change", () => {
    const out = textVideoBackfillPlanLines(
      plan({ scanned: 3, filled: 3, translations: [translationPatch("x:1")], renderings: [renderingPatch("x:2")] }),
    ).join("\n");

    expect(out).toContain("3 stored text(s) carry a bare [영상].");
    expect(out).toContain("would fill 3 marker(s) in 2 row(s).");
  });

  it("says what a translation fill DOES — display only, nothing re-sent", () => {
    const out = textVideoBackfillPlanLines(
      plan({ scanned: 2, filled: 2, translations: [translationPatch("x:1")] }),
    ).join("\n");

    expect(out).toContain("review screens DISPLAY");
    expect(out).toContain("nothing is re-sent");
    expect(out).toContain("published_text is never written");
    expect(out).toContain("x:1 · posted · source_text, korean_text · 2 marker(s)");
  });

  it("says what a rendering fill DOES — the next send attaches the clip", () => {
    const out = textVideoBackfillPlanLines(plan({ scanned: 1, filled: 1, renderings: [renderingPatch("x:2")] })).join("\n");

    expect(out).toContain("NEXT send");
    expect(out).toContain("ATTACHES");
    expect(out).toContain("x:2 · x/x · rendered · 1 marker(s)");
  });

  it("keeps the two effects in separate sections rather than one row total", () => {
    // §6: the operator is deciding between "fix the screens" and "change what goes out". A combined
    // count would hide which of the two they just agreed to.
    const lines = textVideoBackfillPlanLines(
      plan({ scanned: 3, filled: 3, translations: [translationPatch("x:1")], renderings: [renderingPatch("x:2")] }),
    );

    const translations = lines.findIndex((l) => l.startsWith("translations —"));
    const renderings = lines.findIndex((l) => l.startsWith("renderings —"));
    expect(translations).toBeGreaterThan(-1);
    expect(renderings).toBeGreaterThan(translations);
    expect(lines[translations]).toContain("1 row(s), 2 marker(s)");
    expect(lines[renderings]).toContain("1 row(s), 1 marker(s)");
  });

  it("names every skipped text with the column it lives in and what to do about it", () => {
    const lines = textVideoBackfillPlanLines(
      plan({
        scanned: 3,
        skipped: [
          { itemId: "x:6", column: "translations.source_text", bare: 2, reason: { kind: "count-mismatch", markers: 2, videos: 1 } },
          { itemId: "x:7", column: "translations.korean_text", bare: 1, reason: { kind: "url-missing", missing: 1 } },
          { itemId: "lark:abc", column: "translations.source_text", bare: 1, reason: { kind: "no-thread" } },
        ],
      }),
    );

    expect(lines.some((l) => l.startsWith("skipped (3)"))).toBe(true);
    expect(lines).toContain(
      "  x:6 · translations.source_text · 2 marker(s) in the text vs 1 video(s) in the thread — nothing says which clip each marker is",
    );
    expect(lines.some((l) => l.includes("x:7") && l.includes("pnpm x:video-backfill"))).toBe(true);
    expect(lines.some((l) => l.includes("lark:abc") && l.includes("no collected thread"))).toBe(true);
  });

  it("names a skipped rendering by its (type, channel), not just by its column", () => {
    const lines = textVideoBackfillPlanLines(
      plan({
        scanned: 1,
        skipped: [
          {
            itemId: "x:8",
            column: "renderings.text",
            type: "announcement",
            channel: "telegram",
            bare: 2,
            reason: { kind: "count-mismatch", markers: 2, videos: 1 },
          },
        ],
      }),
    );

    expect(lines.some((l) => l.includes("renderings.text (announcement/telegram)"))).toBe(true);
  });
});
