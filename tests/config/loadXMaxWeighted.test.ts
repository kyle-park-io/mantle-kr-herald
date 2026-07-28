import { describe, it, expect, afterEach } from "vitest";
import { loadXMaxWeighted } from "../../src/config";

const orig = process.env.X_PREMIUM;
afterEach(() => { if (orig === undefined) delete process.env.X_PREMIUM; else process.env.X_PREMIUM = orig; });

describe("loadXMaxWeighted", () => {
  it("returns 25000 when X_PREMIUM is exactly 'true'", () => {
    process.env.X_PREMIUM = "true";
    expect(loadXMaxWeighted()).toBe(25000);
  });
  it("tolerates surrounding whitespace", () => {
    process.env.X_PREMIUM = "  true  ";
    expect(loadXMaxWeighted()).toBe(25000);
  });
  it("returns 280 when unset, 'false', or anything else", () => {
    delete process.env.X_PREMIUM;
    expect(loadXMaxWeighted()).toBe(280);
    process.env.X_PREMIUM = "false";
    expect(loadXMaxWeighted()).toBe(280);
    process.env.X_PREMIUM = "1";
    expect(loadXMaxWeighted()).toBe(280);
  });
});
