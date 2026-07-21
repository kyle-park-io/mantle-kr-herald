import { describe, it, expect } from "vitest";
import { PrepareRefinements } from "../../src/app/PrepareRefinements";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { ContentVariant } from "../../src/domain/conversion/models";
import type { GlossaryStore } from "../../src/ports/GlossaryStore";
import type { GlossaryEntry } from "../../src/domain/translation/models";

function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "**메인넷** 출시",
    status: "approved", createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z", ...over };
}
function conversionStore(list: ContentVariant[]): ConversionStore {
  return { loadAll: async () => list, upsert: async () => {}, listConvertedKeys: async () => new Set() };
}
function glossaryStore(list: GlossaryEntry[] = []): GlossaryStore {
  return { load: async () => list, upsertEntry: async () => {} };
}
const entry = (term: string, target: string): GlossaryEntry =>
  ({ term, rule: "transliterate", target, updatedAt: "2026-01-01T00:00:00.000Z" });

describe("PrepareRefinements", () => {
  it("builds a worksheet + pending from approved variants' canonical drafts (default channels)", async () => {
    // announcement → default channels [telegram, kakao]: proves the multi-channel fan-out
    const { worksheet, pending } = await new PrepareRefinements(
      conversionStore([variant({ type: "announcement" })]),
      glossaryStore(),
    ).run({});
    expect(pending).toEqual([
      { itemId: "x:1", type: "announcement", channel: "telegram" },
      { itemId: "x:1", type: "announcement", channel: "kakao" },
    ]);
    expect(worksheet).toContain("## x:1 · 공지 · telegram");
    expect(worksheet).toContain("**메인넷** 출시"); // canonical keeps ** — the draft is not destination-formatted
    expect(worksheet).toContain("보정:");
  });

  it("ignores non-approved variants", async () => {
    const { pending } = await new PrepareRefinements(
      conversionStore([variant({ status: "converted" })]),
      glossaryStore(),
    ).run({});
    expect(pending).toEqual([]);
  });
});

describe("PrepareRefinements — worksheet header", () => {
  it("states the constraints of the channels present in the batch, and no others", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ type: "announcement" })]),
      glossaryStore(),
    ).run({});
    expect(worksheet).toContain("## 채널 제약");
    expect(worksheet).toContain("telegram: 메시지당 4096자");
    expect(worksheet).toContain("500자 초과 시");
    expect(worksheet).not.toContain("트윗당 280 가중치"); // no x channel in this batch
  });

  it("warns against unicode bold in the 쓰는 법 section", async () => {
    const { worksheet } = await new PrepareRefinements(conversionStore([variant()]), glossaryStore()).run({});
    expect(worksheet).toContain("스크린리더");
  });

  it("includes only glossary terms that appear in a draft", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ convertedText: "Mantle 메인넷 출시" })]),
      glossaryStore([entry("Mantle", "맨틀"), entry("Ethereum", "이더리움")]),
    ).run({});
    expect(worksheet).toContain("Mantle");
    expect(worksheet).not.toContain("Ethereum");
  });

  it("omits the glossary section entirely when no term appears", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ convertedText: "아무 용어 없음" })]),
      glossaryStore([entry("Mantle", "맨틀")]),
    ).run({});
    expect(worksheet).not.toContain("## 용어집");
  });

  it("reports weighted length per tweet and names the segment that is over", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ type: "x", convertedText: `짧음\n\n\n${"가".repeat(200)}` })]),
      glossaryStore(),
    ).run({});
    expect(worksheet).toContain("트윗 1/2");
    expect(worksheet).toContain("⚠ 트윗 2/2 — **400/280** (120 초과)");
  });
});

describe("PrepareRefinements — glossary token boundary matching", () => {
  it("does not surface a term that only appears embedded inside a longer word", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ convertedText: "Mantle Index Four 출시" })]),
      glossaryStore([entry("UR", "유알"), entry("DEX", "덱스")]),
    ).run({});
    expect(worksheet).not.toContain("## 용어집");
  });

  it("surfaces a term that appears as a standalone token", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ convertedText: "UR 앱 출시" })]),
      glossaryStore([entry("UR", "유알")]),
    ).run({});
    expect(worksheet).toContain("## 용어집");
    expect(worksheet).toContain("- UR → transliterate: 유알");
  });

  it("matches a $-prefixed term adjacent to Hangul without throwing", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ convertedText: "$MNT입니다" })]),
      glossaryStore([entry("$MNT", "민트")]),
    ).run({});
    expect(worksheet).toContain("## 용어집");
    expect(worksheet).toContain("- $MNT → transliterate: 민트");
  });
});
