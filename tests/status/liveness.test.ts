// tests/status/liveness.test.ts
//
// The server grades; the browser renders. Every rule the chip's colour and wording rest on is
// decided here, where `deploy:smoke`'s own severity table is the one being read.
import { describe, it, expect } from "vitest";
import { summarizeLiveness } from "../../src/status/liveness";

const AT = "2026-08-11T06:23:04.000Z";
const ok = (key: string) => ({ key, status: "ok", detail: "fine" }) as never;
const dead = (key: string, detail = "answered 401") => ({ key, status: "dead", detail }) as never;

describe("summarizeLiveness", () => {
  it("reports ok with no dead probes when everything answered", () => {
    const summary = summarizeLiveness({ observedAt: AT, probes: [ok("google_auth"), ok("telegram")] }, true);
    expect(summary).toEqual({ observedAt: AT, worst: "ok", dead: [], contacted: 2 });
  });

  it("counts a skipped probe as ok — presence is deploy:check's job", () => {
    // A Telegram-only install must not go red because Lark Drive is absent.
    const summary = summarizeLiveness(
      { observedAt: AT, probes: [{ key: "lark", status: "skipped", detail: "not configured" } as never] },
      true,
    );
    expect(summary.worst).toBe("ok");
    expect(summary.dead).toEqual([]);
  });

  it("excludes a skipped probe from `contacted` — it was never dialed, so it must not inflate the headline's count", () => {
    // The gap this closes: `runLiveProbes` always returns all seven results, emitting `skipped` for
    // anything unconfigured, so a Telegram-only install's observation still carries seven entries.
    // Before this test existed, nothing connected a `skipped` probe to the number `livenessHeadline`
    // prints, and `contacted` (then `total`) was `observation.probes.length` — every unconfigured
    // integration silently counted as an answer.
    const summary = summarizeLiveness(
      {
        observedAt: AT,
        probes: [
          ok("telegram"),
          dead("google_auth"),
          { key: "lark", status: "skipped", detail: "not configured" } as never,
          { key: "google_drive_review", status: "skipped", detail: "not configured" } as never,
        ],
      },
      true,
    );
    // Two probes were actually contacted (telegram, google_auth); the two skipped ones must not
    // count even though the observation carries four entries in total.
    expect(summary.contacted).toBe(2);
  });

  it("fails on a dead publishing credential and names it with its tier and reason", () => {
    const summary = summarizeLiveness(
      { observedAt: AT, probes: [ok("telegram"), dead("google_auth", "400 invalid_grant")] },
      true,
    );
    expect(summary.worst).toBe("fail");
    expect(summary.dead).toEqual([
      { key: "google_auth", tier: "publish", severity: "fail", detail: "400 invalid_grant" },
    ]);
  });

  it("softens a dead send credential to warn when sends are closed", () => {
    const probes = { observedAt: AT, probes: [dead("typefully")] };
    expect(summarizeLiveness(probes, true).worst).toBe("fail");
    expect(summarizeLiveness(probes, false).worst).toBe("warn");
    expect(summarizeLiveness(probes, false).dead[0].severity).toBe("warn");
  });

  it("only warns about the Sheet", () => {
    const summary = summarizeLiveness({ observedAt: AT, probes: [dead("google_sheets")] }, true);
    expect(summary.worst).toBe("warn");
    expect(summary.dead[0].tier).toBe("data");
  });

  it("takes the worst severity present, not the last one seen", () => {
    const summary = summarizeLiveness(
      { observedAt: AT, probes: [dead("google_auth"), dead("google_sheets")] },
      true,
    );
    expect(summary.worst).toBe("fail");
    expect(summary.dead).toHaveLength(2);
  });

  it("grades a key it does not recognise as a failing publish credential", () => {
    // A deployment one probe ahead of this build. Not knowing what a credential is for is graded the
    // same as knowing it is dead — the same argument `liveSeverity`'s default branch makes.
    const summary = summarizeLiveness({ observedAt: AT, probes: [dead("something_new")] }, false);
    expect(summary.worst).toBe("fail");
    expect(summary.dead[0].tier).toBe("publish");
  });

  it("carries contacted so the card can say how many probes answered", () => {
    const summary = summarizeLiveness({ observedAt: AT, probes: [ok("google_auth"), ok("lark"), dead("telegram")] }, true);
    expect(summary.contacted).toBe(3);
  });
});
