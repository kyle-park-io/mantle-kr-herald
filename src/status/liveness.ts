import type { ProbeKey, ProbeStatus } from "../doctor/liveProbes";

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
