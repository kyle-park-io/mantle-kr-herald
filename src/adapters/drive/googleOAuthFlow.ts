const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Build the browser consent URL. access_type=offline + prompt=consent guarantee a refresh_token. */
export function buildConsentUrl(params: { clientId: string; redirectUri: string; scope: string }): string {
  const q = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: params.scope,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** Exchange the authorization code from the loopback redirect for tokens. */
export async function exchangeCodeForTokens(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}): Promise<{ refreshToken: string; accessToken: string }> {
  const fetchFn = params.fetchFn ?? fetch;
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) throw new Error(`Google OAuth code exchange failed: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!body.refresh_token) {
    throw new Error("Google OAuth code exchange returned no refresh_token (re-consent with access_type=offline & prompt=consent)");
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token ?? "" };
}
