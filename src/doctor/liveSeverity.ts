import type { ProbeKey } from "./liveProbes";

/**
 * Severity by what the credential is for, not by which API answered. Publishing is what this
 * deployment exists to do, so a dead publish credential fails; sends ship closed and follow the flag
 * the same status payload already carries; the Sheet is header links.
 *
 * `skipped` is ok, never a failure — presence is `deploy:check`'s job, and a Telegram-only install
 * must not go red because Lark Drive is absent. Same split `requirements.ts` draws, same reason.
 *
 * Drive is two keys, not one (`google_drive_review` and `google_drive_approved` — `liveProbes.ts`
 * split it so a broken review folder and a broken approved folder are distinguishable by name), and
 * both are publishing credentials, so both are classified `"publish"` below.
 */
export type ProbeTier = "publish" | "send" | "data";

/** The three gradings a dead credential can carry. Identical to `CheckResult["status"]`, which is
 *  what `smokeChecks.ts` still assigns it to. */
export type Severity = "ok" | "warn" | "fail";

/**
 * `Record<ProbeKey, ProbeTier>`, not two arrays checked with `.includes()`. The array shape is what
 * this map replaced: a probe added to `runLiveProbes` (`liveProbes.ts`) but never added to either
 * list produced no compile error — `.includes()` on a plain string list accepts, and silently
 * rejects, any string equally — and fell through to `warn` regardless of `sendsEnabled`, which is a
 * milder replay of the exact false-green incident this plan responds to. `LiveProbeResult.key` is
 * typed `ProbeKey`, so a `Record` indexed by that same union makes the classification exhaustive:
 * adding a key to `ProbeKey` without adding it here fails `pnpm typecheck` at this object literal,
 * not at some caller three files away.
 */
export const PROBE_TIER: Record<ProbeKey, ProbeTier> = {
  google_auth: "publish",
  google_drive_review: "publish",
  google_drive_approved: "publish",
  lark: "publish",
  typefully: "send",
  telegram: "send",
  google_sheets: "data",
};

/**
 * `dead`/`ok`/`skipped` was already judged by the caller; this only classifies a `dead` probe's
 * severity by tier. The `default` branch is the runtime half of the same "unknown is not-known"
 * argument the `undefined`-route case above already makes: `PROBE_TIER` is exhaustive over `ProbeKey`
 * at compile time, but a key can still reach here having escaped the type system — a hand-built
 * `LiveProbeResult` in a test, or a live deployment answering with a probe key this build of
 * `deploy:smoke` predates. Defaulting to `fail` rather than `warn` matches the rest of this module:
 * this command's whole purpose is to stop a deploy reading as healthy when something is unverified,
 * so not-knowing which tier a credential belongs to is graded the same as knowing it is dead.
 */
export function liveSeverity(key: ProbeKey, sendsEnabled: boolean): Severity {
  const tier = PROBE_TIER[key];
  switch (tier) {
    case "publish":
      return "fail";
    case "send":
      return sendsEnabled ? "fail" : "warn";
    case "data":
      return "warn";
    default:
      return "fail";
  }
}

/**
 * Every key the report is expected to carry, derived from `PROBE_TIER` rather than written out
 * again. `PROBE_TIER` is a `Record<ProbeKey, …>`, so this list is exhaustive over `ProbeKey` by
 * construction and a probe added to `liveProbes.ts` joins it with no edit here — the same
 * compile-time guarantee, reused rather than re-established next to it where the two could disagree.
 */
export const EXPECTED_PROBE_KEYS = Object.keys(PROBE_TIER) as ProbeKey[];
