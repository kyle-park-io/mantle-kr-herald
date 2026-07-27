import { describe, it, expect } from "vitest";
import { paths } from "../src/paths";

describe("reference store isolation", () => {
  it("keeps the reference store under output/x/reference, distinct from the source store", () => {
    expect(paths.referenceItems).toContain("/output/x/reference/");
    expect(paths.referenceItems).not.toBe(paths.xItems);
    expect(paths.referenceRuns).not.toBe(paths.xRuns);
  });

  it("places the pairing artifacts in the reference dir", () => {
    expect(paths.referencePairsProposed).toContain("/output/x/reference/");
    expect(paths.referencePairsReview).toContain("/output/x/reference/");
  });
});
