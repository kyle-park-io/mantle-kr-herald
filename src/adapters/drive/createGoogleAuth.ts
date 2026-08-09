import type { GoogleAuthConfig } from "../../config";
import type { TokenSource } from "./TokenSource";
import { GoogleServiceAccountAuth } from "./GoogleServiceAccountAuth";
import { GoogleOAuthAuth } from "./GoogleOAuthAuth";

/**
 * `fetchFn` is optional and defaults to the global `fetch`, which is what every caller but one
 * passes. The exception is `buildLiveProbeInput` (`src/doctor/liveProbes.ts`), which hands in a
 * `fetch` carrying the probe run's own `AbortSignal`: neither auth class reads a signal from
 * anywhere else, so without this parameter a hanging token endpoint has nothing to cancel it and
 * `runLiveProbes`' deadline can only stop WAITING for the refresh, not stop the socket — which
 * leaves a CLI unable to exit and a Vercel function running until the platform 504s it.
 */
export async function createGoogleAuth(cfg: GoogleAuthConfig, fetchFn: typeof fetch = fetch): Promise<TokenSource> {
  if (cfg.mode === "oauth") {
    return new GoogleOAuthAuth({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }, cfg.refreshToken, Date.now, fetchFn);
  }
  return GoogleServiceAccountAuth.fromKeyFile(cfg.saKeyFile, fetchFn);
}
