import { describe, it, expect, afterEach } from "vitest";
import { quotaReader } from "../../src/cli/typefullyQuotaReader";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe("quotaReader", () => {
  it("is undefined when X is not a target", () => {
    process.env.TYPEFULLY_API_KEY = "KEY";
    process.env.TYPEFULLY_SOCIAL_SET_ID = "42";
    expect(quotaReader(["telegram"])).toBeUndefined();
  });

  // A Telegram-only install has no Typefully credentials; it must not fail to start over a gate
  // that has nothing to guard.
  it("is undefined when Typefully is unconfigured", () => {
    delete process.env.TYPEFULLY_API_KEY;
    delete process.env.TYPEFULLY_SOCIAL_SET_ID;
    expect(quotaReader(["x"])).toBeUndefined();
  });

  it("is a reader when X is a target and Typefully is configured", () => {
    process.env.TYPEFULLY_API_KEY = "KEY";
    process.env.TYPEFULLY_SOCIAL_SET_ID = "42";
    expect(typeof quotaReader(["x"])).toBe("function");
  });
});
