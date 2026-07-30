import { describe, it, expect } from "vitest";
import { KOL_TELEGRAM_HEADER, KOL_MAP_HEADER } from "../../../src/domain/kol/models";

describe("kol sheet headers", () => {
  it("pins the kol-telegram-posts column order (A-M)", () => {
    expect(KOL_TELEGRAM_HEADER).toEqual([
      "kolId", "tgHandle", "postedAt", "deliverableLink", "views", "engagements",
      "reactionsDetail", "itemId", "topic", "matchScore", "pricePerPost", "fetchedAt", "confirmed",
    ]);
  });

  it("pins the kol-map column order (A-E)", () => {
    expect(KOL_MAP_HEADER).toEqual(["kolId", "tgHandle", "sheetLabel", "pricePerPost", "active"]);
  });

  it("keeps deliverableLink at column D, the upsert key", () => {
    expect(KOL_TELEGRAM_HEADER.indexOf("deliverableLink")).toBe(3);
  });
});
