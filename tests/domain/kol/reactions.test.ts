import { describe, it, expect } from "vitest";
import { sumReactions, formatReactions } from "../../../src/domain/kol/reactions";

describe("sumReactions", () => {
  it("matches the engagement the sheet recorded for Marine's USPXx post", () => {
    // Sheet Jul. r12 says 3; the page serves 👍2 + ❤1.
    expect(sumReactions([{ emoji: "👍", count: 2 }, { emoji: "❤", count: 1 }])).toBe(3);
  });

  it("is 0 for a post with no reactions", () => {
    expect(sumReactions([])).toBe(0);
  });
});

describe("formatReactions", () => {
  it("renders the human-auditable detail string", () => {
    expect(formatReactions([{ emoji: "👍", count: 2 }, { emoji: "❤", count: 1 }])).toBe("👍2 ❤1");
  });

  it("is an empty string for no reactions, so the cell reads as blank", () => {
    expect(formatReactions([])).toBe("");
  });
});
