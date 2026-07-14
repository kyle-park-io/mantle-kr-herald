import type { GoogleAuthConfig } from "../../config";
import type { TokenSource } from "./TokenSource";
import { GoogleServiceAccountAuth } from "./GoogleServiceAccountAuth";
import { GoogleOAuthAuth } from "./GoogleOAuthAuth";

export async function createGoogleAuth(cfg: GoogleAuthConfig): Promise<TokenSource> {
  if (cfg.mode === "oauth") {
    return new GoogleOAuthAuth({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }, cfg.refreshToken);
  }
  return GoogleServiceAccountAuth.fromKeyFile(cfg.saKeyFile);
}
