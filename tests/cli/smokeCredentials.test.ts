import { describe, it, expect } from "vitest";
import { smokeCredentials } from "../../src/cli/smokeCredentials";

describe("smokeCredentials", () => {
  it("takes both from the environment when both are set", () => {
    expect(smokeCredentials({ HERALD_SMOKE_USERNAME: "kr", HERALD_SMOKE_PASSWORD: "pw" })).toEqual({
      kind: "env",
      username: "kr",
      password: "pw",
    });
  });

  it("falls back to prompting when neither is set", () => {
    expect(smokeCredentials({})).toEqual({ kind: "prompt" });
  });

  it("trims the username but never the password", () => {
    // A trailing space in a pasted username is a typo; in a password it is a character.
    const c = smokeCredentials({ HERALD_SMOKE_USERNAME: " kr \n", HERALD_SMOKE_PASSWORD: " pw " });
    expect(c).toEqual({ kind: "env", username: "kr", password: " pw " });
  });

  it("refuses when only the username is set", () => {
    // The failure this prevents: a CI job with half the secrets configured falls through to a
    // prompt on a runner with no tty and hangs until the job times out, which reads as a broken
    // deployment rather than a missing secret.
    const c = smokeCredentials({ HERALD_SMOKE_USERNAME: "kr" });
    expect(c.kind).toBe("refuse");
    expect(c.kind === "refuse" && c.reason).toMatch(/HERALD_SMOKE_PASSWORD/);
  });

  it("refuses when only the password is set", () => {
    const c = smokeCredentials({ HERALD_SMOKE_PASSWORD: "pw" });
    expect(c.kind).toBe("refuse");
    expect(c.kind === "refuse" && c.reason).toMatch(/HERALD_SMOKE_USERNAME/);
  });

  it("refuses a blank value rather than treating it as unset", () => {
    // Set-but-empty is a misconfiguration, not a request to prompt. Prompting here would silently
    // ignore a secret someone believed they had configured.
    const c = smokeCredentials({ HERALD_SMOKE_USERNAME: "  ", HERALD_SMOKE_PASSWORD: "pw" });
    expect(c.kind).toBe("refuse");
    expect(c.kind === "refuse" && c.reason).toMatch(/HERALD_SMOKE_USERNAME/);
  });

  it("refuses an empty password rather than spending a login attempt on it", () => {
    const c = smokeCredentials({ HERALD_SMOKE_USERNAME: "kr", HERALD_SMOKE_PASSWORD: "" });
    expect(c.kind).toBe("refuse");
    expect(c.kind === "refuse" && c.reason).toMatch(/HERALD_SMOKE_PASSWORD/);
  });
});
