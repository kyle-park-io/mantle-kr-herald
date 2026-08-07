import { describe, expect, it } from "vitest";
import { ALL_TRANSLATION_STATUSES } from "../../src/domain/translation/models";

describe("translation statuses", () => {
  // The array is the runtime source of truth. A `satisfies`-checked literal erases under esbuild —
  // see the same argument on ALL_DELIVERY_STATUSES in src/domain/delivery/models.ts.
  it("carries all three statuses at runtime", () => {
    expect([...ALL_TRANSLATION_STATUSES]).toEqual(["translated", "approved", "posted"]);
  });
});
