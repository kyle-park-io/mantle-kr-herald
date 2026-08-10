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
  total: number;
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
  for (const probe of observation.probes) {
    if (probe.status !== "dead") continue;
    // `liveSeverity` can return "ok", but never does for a probe that reached this branch — every
    // tier's dead outcome is "warn" or "fail" (see `liveSeverity`'s switch). The `=== "warn" ? ...`
    // form below is how that narrowing is expressed without re-deriving the tier table here.
    const severity = liveSeverity(probe.key, sendsEnabled) === "warn" ? "warn" : "fail";
    dead.push({ key: probe.key, tier: PROBE_TIER[probe.key] ?? "publish", severity, detail: probe.detail });
    if (WORSE[severity] > WORSE[worst]) worst = severity;
  }
  return { observedAt: observation.observedAt, worst, dead, total: observation.probes.length };
}
