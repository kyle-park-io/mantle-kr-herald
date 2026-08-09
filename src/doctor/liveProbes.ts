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
  /** Google only: the scopes `tokeninfo` reported for the access token this probe obtained. */
  grantedScopes?: string[];
  /** The HTTP status a failed call actually answered with, so a caller can tell 403 from 404
   *  (`sheetAccessResult` in `src/doctor/checks.ts` needs exactly this — a 404 means two different
   *  things depending on whether the `spreadsheets` scope was granted). Absent when the probe never
   *  reached the network at all (not configured, or blocked on a token that never came). */
  httpStatus?: number;
  /** Typefully only, from the social-set response's `publishing_quota`. `limit` is `used + remaining`
   *  — the module doesn't forward `used` on its own, since the resend guard (`TypefullyQuota.ts`)
   *  treats "absent" and "zero" as different answers for that field and callers here don't need it
   *  raw, only combined into a total. */
  quota?: { remaining: number; limit: number; resetsAt?: string };
  /** Google Drive/Sheet only: the resource's own display name/title, when the response carried one.
   *  `accessResult`/`sheetAccessResult` (`src/doctor/checks.ts`) use it to name what was actually
   *  reached, not just that something was — restoring the same evidence the pre-module `doctor --live`
   *  showed (`accessible (review)`, not just `accessible`). */
  resourceName?: string;
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

/** A space-separated OAuth scope string → array (empties dropped). Duplicated from
 *  `src/doctor/checks.ts`'s own `parseScopes` rather than imported: that module pulls in `../config`
 *  and `../adapters/db/*` for its other exports, and this one is a leaf probe module that promises
 *  never to grow a database dependency just to parse a header. */
function parseScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter((s) => s.length > 0);
}

type ProbeExtras = Partial<Pick<LiveProbeResult, "grantedScopes" | "httpStatus" | "quota" | "resourceName">>;

const skipped = (key: string, why: string): LiveProbeResult => ({ key, status: "skipped", detail: `not configured — ${why}` });
const dead = (key: string, detail: string, extras: ProbeExtras = {}): LiveProbeResult => ({ key, status: "dead", detail, ...extras });
const alive = (key: string, detail: string, extras: ProbeExtras = {}): LiveProbeResult => ({ key, status: "ok", detail, ...extras });

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
    const result = await run();
    // Redact on the return path too, not only on throw. A Lark probe returning dead because its
    // 200-OK body has a non-zero code would leak a secret if the provider echoes back what was
    // sent (e.g., { code: 10003, msg: "invalid app_secret: <the-real-secret>" }). Returning is
    // as common a failure path as throwing, and probes return dead() directly without exception.
    return { ...result, detail: redact(result.detail, secrets) };
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

  // Result order (== the array order returned below), fixed and callers may rely on it:
  //   google_auth, google_drive_review, google_drive_approved, google_sheets, lark, typefully, telegram
  // Drive was a single "google_drive" key through 2026-08-10, covering both folders in one result.
  // It split into a key per folder so a broken review folder and a broken approved folder are
  // distinguishable by name — the way `doctor --live` told them apart before this module replaced
  // its inline checks.

  // Google first and alone: Drive and Sheets both need the token this produces, so they cannot run
  // in parallel with it. Everything after this point does.
  let token: string | undefined;
  const googleAuth = input.googleToken
    ? await attempt("google_auth", [], async () => {
        token = await input.googleToken!();
        // Best-effort: which scopes actually ended up on the token matters to callers (a token
        // missing `spreadsheets` scope is a different fix than a wrong GSHEET_ID — see
        // `sheetAccessResult`), but `tokeninfo` failing must not fail this probe: the token itself
        // still refreshed, which is what "ok" means here. The failure is discarded, not returned or
        // rethrown, so it can never carry the token — which is literally in this call's URL — into a
        // detail string or an exception `attempt()` would otherwise redact-and-report.
        let grantedScopes: string[] | undefined;
        try {
          const info = (await fetchFn(
            `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
            { signal: signal() },
          ).then((r) => r.json())) as { scope?: string };
          grantedScopes = parseScopes(info.scope);
        } catch {
          /* tokeninfo unreachable — the token still refreshed; scopes just aren't known this run */
        }
        return alive("google_auth", "token refreshed", { grantedScopes });
      })
    : skipped("google_auth", "no Google OAuth credentials");

  const DRIVE_NOT_CONFIGURED = "GDRIVE_REVIEW_FOLDER_ID / GDRIVE_APPROVED_FOLDER_ID unset";
  /** One folder's reachability, parameterised by key/label/id — `input.googleDrive` is only ever
   *  present with both ids set (`loadGoogleDriveConfig` requires both together), so the two probes
   *  built from it only differ in which folder they name. */
  const driveFolder = (key: string, label: string, id: string) => async (): Promise<LiveProbeResult> => {
    if (!token) return dead(key, "not checked — the Google token could not be refreshed");
    // `,name` alongside `id`: the same extra field the pre-module implementation asked for, so the
    // rendered check can name the folder it reached, not just report that reaching it worked.
    const res = await fetchFn(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal(),
    });
    if (!res.ok) return dead(key, `${label} folder unreachable — HTTP ${res.status}`, { httpStatus: res.status });
    const body = (await res.json()) as { name?: string };
    return alive(key, `${label} folder reachable`, { resourceName: body.name });
  };
  const googleDriveReview = input.googleDrive
    ? driveFolder("google_drive_review", "review", input.googleDrive.reviewFolderId)
    : async () => skipped("google_drive_review", DRIVE_NOT_CONFIGURED);
  const googleDriveApproved = input.googleDrive
    ? driveFolder("google_drive_approved", "approved", input.googleDrive.approvedFolderId)
    : async () => skipped("google_drive_approved", DRIVE_NOT_CONFIGURED);

  const googleSheets = async (): Promise<LiveProbeResult> => {
    if (!input.googleSheetId) return skipped("google_sheets", "GSHEET_ID unset");
    if (!token) return dead("google_sheets", "not checked — the Google token could not be refreshed");
    // `,properties.title` alongside `spreadsheetId`: same reasoning as the Drive folder's `,name` above.
    const res = await fetchFn(
      `https://sheets.googleapis.com/v4/spreadsheets/${input.googleSheetId}?fields=spreadsheetId,properties.title`,
      { headers: { Authorization: `Bearer ${token}` }, signal: signal() },
    );
    if (!res.ok) return dead("google_sheets", `HTTP ${res.status}`, { httpStatus: res.status });
    const body = (await res.json()) as { properties?: { title?: string } };
    return alive("google_sheets", "spreadsheet reachable", { resourceName: body.properties?.title });
  };

  const lark = async (): Promise<LiveProbeResult> => {
    if (!input.lark) return skipped("lark", "LARK_APP_ID / LARK_APP_SECRET unset");
    const res = await fetchFn(`${input.lark.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: input.lark.appId, app_secret: input.lark.appSecret }),
      signal: signal(),
    });
    if (!res.ok) return dead("lark", `HTTP ${res.status}`, { httpStatus: res.status });
    // Lark answers 200 with a non-zero `code` for a bad secret — the status line alone would pass.
    const body = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };
    if (body.code !== 0 || !body.tenant_access_token) {
      return dead("lark", `Lark code ${body.code} — ${body.msg ?? "no message"}`);
    }

    // A tenant token issues fine for an app that has been removed from every room — proving the
    // token is real is not proving `pnpm collect-lark` (im:message.group_msg) has anything to read.
    // Listing chats needs nothing beyond the app credentials already used above (see `pnpm
    // lark:chats`, meant to run before any chat id is known — LARK_CHAT_IDS is deliberately unset on
    // the deployment), so this evidence is available in both places this module runs. A chat-list
    // failure must not fail this probe: the token itself is still real, so it degrades to the
    // token-only detail rather than propagating. Reports a count, never chat names — a name is
    // response content this module has no reason to trust is safe to print.
    try {
      const chats = await fetchFn(`${input.lark.baseUrl}/open-apis/im/v1/chats?page_size=100`, {
        headers: { Authorization: `Bearer ${body.tenant_access_token}` },
        signal: signal(),
      });
      const chatsBody = (await chats.json()) as { code?: number; data?: { items?: unknown[] } };
      if (chats.ok && chatsBody.code === 0) {
        const n = chatsBody.data?.items?.length ?? 0;
        return alive("lark", `tenant token OK · bot in ${n} chat(s) (im:message.group_msg verified by pnpm collect-lark)`);
      }
    } catch {
      /* chat list unreachable — the tenant token itself is still real */
    }
    return alive("lark", "tenant token issued — could not verify chat membership");
  };

  const typefully = async (): Promise<LiveProbeResult> => {
    if (!input.typefully) return skipped("typefully", "TYPEFULLY_API_KEY / TYPEFULLY_SOCIAL_SET_ID unset");
    const res = await fetchFn(`https://api.typefully.com/v2/social-sets/${input.typefully.socialSetId}/`, {
      headers: { Authorization: `Bearer ${input.typefully.apiKey}` },
      signal: signal(),
    });
    if (!res.ok) return dead("typefully", `HTTP ${res.status}`, { httpStatus: res.status });
    // Same field names TypefullyQuota.ts reads off this response. `used` is required, not defaulted,
    // there too — an absent `used` is a different (and untrustworthy) answer from a real zero, per
    // that file's own comment — so a response missing either number is reported reachable with no
    // quota, rather than guessing one.
    const body = (await res.json()) as { publishing_quota?: { used?: number; remaining?: number; resets_at?: string } };
    const q = body.publishing_quota;
    if (!q || typeof q.remaining !== "number" || typeof q.used !== "number") {
      return alive("typefully", "social set reachable");
    }
    return alive("typefully", "social set reachable", {
      quota: { remaining: q.remaining, limit: q.used + q.remaining, resetsAt: q.resets_at },
    });
  };

  const telegram = async (): Promise<LiveProbeResult> => {
    if (!input.telegramBotToken) return skipped("telegram", "TELEGRAM_BOT_TOKEN unset");
    // getMe validates the token and sends nothing. The token is in the path — see `redact`.
    const res = await fetchFn(`https://api.telegram.org/bot${input.telegramBotToken}/getMe`, { signal: signal() });
    return res.ok
      ? alive("telegram", "bot token valid")
      : dead("telegram", `HTTP ${res.status}`, { httpStatus: res.status });
  };

  const secrets = [input.lark?.appSecret, input.typefully?.apiKey, input.telegramBotToken, token];
  const rest = await Promise.all([
    attempt("google_drive_review", secrets, googleDriveReview),
    attempt("google_drive_approved", secrets, googleDriveApproved),
    attempt("google_sheets", secrets, googleSheets),
    attempt("lark", secrets, lark),
    attempt("typefully", secrets, typefully),
    attempt("telegram", secrets, telegram),
  ]);

  return [googleAuth, ...rest];
}
