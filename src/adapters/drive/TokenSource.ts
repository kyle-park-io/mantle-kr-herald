/** Provides a Google API bearer access token. Implemented by both the service-account
 *  (JWT) and OAuth (refresh-token) auth strategies. */
export interface TokenSource {
  getToken(): Promise<string>;
}
