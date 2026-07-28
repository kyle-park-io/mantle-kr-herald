import { describe, it, expect } from "vitest";
import { matchesItemId } from "../../src/domain/itemId";

describe("matchesItemId", () => {
  it("matches the full itemId", () => {
    expect(matchesItemId(new Set(["x:2072340833760936293"]), "x:2072340833760936293")).toBe(true);
  });
  it("matches the bare id (source prefix omitted)", () => {
    expect(matchesItemId(new Set(["2072340833760936293"]), "x:2072340833760936293")).toBe(true);
  });
  it("does not match an unrelated id", () => {
    expect(matchesItemId(new Set(["999"]), "x:2072340833760936293")).toBe(false);
  });
  it("with multiple ids, matches whichever form is present", () => {
    expect(matchesItemId(new Set(["lark:abc", "2072340833760936293"]), "x:2072340833760936293")).toBe(true);
  });
});
