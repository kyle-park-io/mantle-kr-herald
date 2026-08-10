import type { ProbeKey, ProbeStatus } from "../doctor/liveProbes";
import { PROBE_TIER, liveSeverity, type ProbeTier, type Severity } from "../doctor/liveSeverity";

/** The three fields of a probe result the board renders. Deliberately not the whole
 *  `LiveProbeResult`: `grantedScopes`, `quota`, `httpStatus` and `resourceName` serve
 *  `deploy:smoke`'s terminal output and have no reader here. */
export interface StoredProbe {
  key: ProbeKey;
  status: ProbeStatus;
  detail: string;
}

/** What a deployment observed about its own credentials, and when. */
export interface LivenessObservation {
  probes: StoredProbe[];
  observedAt: string;
}

/** A credential that did not answer, with everything the card needs to name it and everything the
 *  chip needs to word itself. `tier` is carried rather than re-derived in the browser: the tier
 *  table lives on this side, and a copy of it in `web/src` is how the CLI and the header drifted
 *  apart the last time. */
export interface DeadProbe {
  key: ProbeKey;
  tier: ProbeTier;
  severity: "warn" | "fail";
  detail: string;
}

/** What `/api/status` carries about the last observation. Small on purpose — it is on the payload
 *  the board fetches on every load. */
export interface LivenessSummary {
  observedAt: string;
  worst: Severity;
  dead: DeadProbe[];
  /**
   * How many probes `runLiveProbes` actually contacted — `status !== "skipped"` — not how many keys
   * this build knows about. `runLiveProbes` always returns all seven results, emitting `skipped` for
   * anything unconfigured, so counting `observation.probes.length` here would let
   * `livenessHeadline` print "7개 모두 응답" on a Telegram-only install where four integrations were
   * never dialed — a false green one line below the false green this feature exists to remove.
   * Excluding `skipped` is the same rule `worst`/`dead` already apply above: presence is
   * `deploy:check`'s job, not this card's.
   */
  contacted: number;
}

const WORSE: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };

/**
 * Grades one observation with the same policy `deploy:smoke` prints, so a credential that fails a
 * deploy and the same credential on the board can never disagree about how serious it is.
 *
 * `skipped` grades ok alongside `ok`, exactly as `checkLiveness` does: presence is `deploy:check`'s
 * job, and an install that never configured Lark must not read as broken.
 */
export function summarizeLiveness(observation: LivenessObservation, sendsEnabled: boolean): LivenessSummary {
  const dead: DeadProbe[] = [];
  let worst: Severity = "ok";
  let contacted = 0;
  for (const probe of observation.probes) {
    if (probe.status === "skipped") continue;
    contacted++;
    if (probe.status !== "dead") continue;
    // `liveSeverity` can return "ok", but never does for a probe that reached this branch — every
    // tier's dead outcome is "warn" or "fail" (see `liveSeverity`'s switch). The `=== "warn" ? ...`
    // form below is how that narrowing is expressed without re-deriving the tier table here.
    const severity = liveSeverity(probe.key, sendsEnabled) === "warn" ? "warn" : "fail";
    dead.push({ key: probe.key, tier: PROBE_TIER[probe.key] ?? "publish", severity, detail: probe.detail });
    if (WORSE[severity] > WORSE[worst]) worst = severity;
  }
  return { observedAt: observation.observedAt, worst, dead, contacted };
}
