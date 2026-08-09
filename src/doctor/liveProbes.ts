/**
 * Does each configured credential still work — not merely exist. `deploy:check` can only read
 * variable NAMES (`--sensitive` values cannot be read back at all), and the deployment's own status
 * payload reports presence by construction (`createDeps.ts`: "env only, no live calls"), so this is
 * the only thing in the repo that can tell a revoked token from a live one.
 *
 * Runs in two places from one copy: `pnpm doctor --live` locally, and inside the deployment behind
 * `GET /api/diagnostics/live`. A second implementation would drift from the first, and the drifted
 * one would be the copy running in production.
 *
 * Config comes in already loaded — this module never reads `process.env`. That keeps it honest
 * under test and lets the caller decide what "configured" means.
 */

export type ProbeStatus = "ok" | "dead" | "skipped";

export interface LiveProbeResult {
  key: string;
  status: ProbeStatus;
  /** Human-readable, English, and — enforced below — never containing a credential. */
  detail: string;
}

export interface LiveProbeInput {
  /** Refreshes an access token. Absent when Google auth is not configured. */
  googleToken?: () => Promise<string>;
  googleDrive?: { reviewFolderId: string; approvedFolderId: string };
  googleSheetId?: string;
  lark?: { appId: string; appSecret: string; baseUrl: string };
  typefully?: { apiKey: string; socialSetId: string };
  telegramBotToken?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

const skipped = (key: string, why: string): LiveProbeResult => ({ key, status: "skipped", detail: `not configured — ${why}` });
const dead = (key: string, detail: string): LiveProbeResult => ({ key, status: "dead", detail });
const alive = (key: string, detail: string): LiveProbeResult => ({ key, status: "ok", detail });

/**
 * Replaces every secret with `***`. Not belt-and-braces: the Telegram probe puts its bot token in
 * the URL path, and `fetch`'s own errors quote the URL, so without this a network blip publishes the
 * token into a terminal and a CI log. Short values are left alone — redacting a 3-character string
 * would blank out unrelated text and hide the actual error.
 */
function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("***");
  }
  return out;
}

/** A probe never throws: a diagnostic that dies when something is wrong is no diagnostic. */
async function attempt(
  key: string,
  secrets: readonly (string | undefined)[],
  run: () => Promise<LiveProbeResult>,
): Promise<LiveProbeResult> {
  try {
    return await run();
  } catch (err) {
    return dead(key, redact(err instanceof Error ? err.message : String(err), secrets));
  }
}

export async function runLiveProbes(
  input: LiveProbeInput,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<LiveProbeResult[]> {
  const signal = (): AbortSignal => AbortSignal.timeout(timeoutMs);

  // Google first and alone: Drive and Sheets both need the token this produces, so they cannot run
  // in parallel with it. Everything after this point does.
  let token: string | undefined;
  const googleAuth = input.googleToken
    ? await attempt("google_auth", [], async () => {
        token = await input.googleToken!();
        return alive("google_auth", "token refreshed");
      })
    : skipped("google_auth", "no Google OAuth credentials");

  const googleDrive = async (): Promise<LiveProbeResult> => {
    if (!input.googleDrive) return skipped("google_drive", "GDRIVE_REVIEW_FOLDER_ID / GDRIVE_APPROVED_FOLDER_ID unset");
    if (!token) return dead("google_drive", "not checked — the Google token could not be refreshed");
    for (const [label, id] of [
      ["review", input.googleDrive.reviewFolderId],
      ["approved", input.googleDrive.approvedFolderId],
    ] as const) {
      const res = await fetchFn(`https://www.googleapis.com/drive/v3/files/${id}?fields=id`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: signal(),
      });
      if (!res.ok) return dead("google_drive", `${label} folder unreachable — HTTP ${res.status}`);
    }
    return alive("google_drive", "review and approved folders reachable");
  };

  const googleSheets = async (): Promise<LiveProbeResult> => {
    if (!input.googleSheetId) return skipped("google_sheets", "GSHEET_ID unset");
    if (!token) return dead("google_sheets", "not checked — the Google token could not be refreshed");
    const res = await fetchFn(
      `https://sheets.googleapis.com/v4/spreadsheets/${input.googleSheetId}?fields=spreadsheetId`,
      { headers: { Authorization: `Bearer ${token}` }, signal: signal() },
    );
    return res.ok ? alive("google_sheets", "spreadsheet reachable") : dead("google_sheets", `HTTP ${res.status}`);
  };

  const lark = async (): Promise<LiveProbeResult> => {
    if (!input.lark) return skipped("lark", "LARK_APP_ID / LARK_APP_SECRET unset");
    const res = await fetchFn(`${input.lark.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: input.lark.appId, app_secret: input.lark.appSecret }),
      signal: signal(),
    });
    if (!res.ok) return dead("lark", `HTTP ${res.status}`);
    // Lark answers 200 with a non-zero `code` for a bad secret — the status line alone would pass.
    const body = (await res.json()) as { code?: number; msg?: string };
    return body.code === 0
      ? alive("lark", "tenant token issued")
      : dead("lark", `Lark code ${body.code} — ${body.msg ?? "no message"}`);
  };

  const typefully = async (): Promise<LiveProbeResult> => {
    if (!input.typefully) return skipped("typefully", "TYPEFULLY_API_KEY / TYPEFULLY_SOCIAL_SET_ID unset");
    const res = await fetchFn(`https://api.typefully.com/v2/social-sets/${input.typefully.socialSetId}/`, {
      headers: { Authorization: `Bearer ${input.typefully.apiKey}` },
      signal: signal(),
    });
    return res.ok ? alive("typefully", "social set reachable") : dead("typefully", `HTTP ${res.status}`);
  };

  const telegram = async (): Promise<LiveProbeResult> => {
    if (!input.telegramBotToken) return skipped("telegram", "TELEGRAM_BOT_TOKEN unset");
    // getMe validates the token and sends nothing. The token is in the path — see `redact`.
    const res = await fetchFn(`https://api.telegram.org/bot${input.telegramBotToken}/getMe`, { signal: signal() });
    return res.ok ? alive("telegram", "bot token valid") : dead("telegram", `HTTP ${res.status}`);
  };

  const secrets = [input.lark?.appSecret, input.typefully?.apiKey, input.telegramBotToken, token];
  const rest = await Promise.all([
    attempt("google_drive", secrets, googleDrive),
    attempt("google_sheets", secrets, googleSheets),
    attempt("lark", secrets, lark),
    attempt("typefully", secrets, typefully),
    attempt("telegram", secrets, telegram),
  ]);

  return [googleAuth, ...rest];
}
