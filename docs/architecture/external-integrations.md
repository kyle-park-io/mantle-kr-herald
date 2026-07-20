# External integrations — APIs & MCP

What this project talks to over the network, and how. The runtime is **headless**
(coded REST, `zod`-only, native `fetch`) and runs on each operator's **local machine**.
**No MCP server is part of the pipeline.**

## Google APIs (Drive today, Sheets planned)

Every Google call carries a Bearer access token from a shared `TokenSource`
(`src/adapters/drive/`), which is either **OAuth user-delegation** or a **service-account
JWT** — `createGoogleAuth` selects one from `GOOGLE_AUTH_MODE`. Setup:
`docs/guides/google-drive-setup-guide.md`.

| API | Endpoint(s) | Used by | Scope |
| --- | --- | --- | --- |
| **Drive v3 — upload** | `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart` | `GoogleDriveUploader` (`pnpm drive:publish`) — uploads Markdown as a new file | `drive.file` |
| **Drive v3 — update** | `PATCH https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=multipart` | `GoogleDriveUploader` (`pnpm drive:publish`) — replaces the content of a `stale` file in place, preserving its file id and `webViewLink` | `drive.file` |
| **Drive v3 — files/permissions** | `https://www.googleapis.com/drive/v3/files` (create folder, list, `…/permissions`) | `GoogleDriveProvisioner` (`pnpm drive:init`) — create + share folders | `drive.file` |
| **OAuth2 — token** | `POST https://oauth2.googleapis.com/token` | `GoogleOAuthAuth` (refresh→access), `GoogleServiceAccountAuth` (JWT→access), `googleOAuthFlow` (code→tokens) | — |
| **OAuth2 — consent** | `https://accounts.google.com/o/oauth2/v2/auth` | `pnpm google:auth` (one-time consent) | — |
| **Sheets v4 — data hub (§9a)** | `https://sheets.googleapis.com/v4/spreadsheets/…` (values get/append/update, create) | `GoogleSheetClient` — `pnpm sheet:init` / `targets:list` / `history:record` (수신처 / 이력; 임프레션 = §9b) | `spreadsheets` |

**Auth notes**
- Default scope is least-privilege `drive.file` (`DRIVE_FILE_SCOPE`), overridable via `GOOGLE_OAUTH_SCOPE`.
- **Service accounts have no Drive storage quota** → they cannot create/own files in a
  personal Gmail Drive (403 `storageQuotaExceeded`). Use **OAuth user-delegation** for a
  personal Gmail (files owned by the user); service accounts only work against a
  Workspace/Shared Drive. A Google **Sheet is a Drive file**, so the same rule applies —
  §9 uses OAuth, **no Workspace required**.
- To add Sheets access, re-mint the refresh token with both scopes:
  `GOOGLE_OAUTH_SCOPE="https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets"`
  then re-run `pnpm google:auth`.

## MCP

**The pipeline uses no MCP.** All automation is coded REST so it can run unattended on a
local machine. MCP servers (Google Drive, Gmail, Calendar, …) that may appear in a Claude
Code session are **assistant-side dev tooling** — not part of this codebase or its runtime.

The proposal (`design/social-media-automation-proposal.md` §9) floated "Excel MCP" for the
Sheet data hub. That is **superseded**: §9 is built on the **direct Google Sheets REST API**
(above), reusing the existing `TokenSource`, so it fits the headless coded-REST model and
adds no runtime dependency. An operator may still use a Sheets/Excel MCP interactively (via
Claude) to eyeball or hand-edit a sheet — that is independent of, and not required by, the pipeline.

## Other external APIs

| Service | Base URL | Used by |
| --- | --- | --- |
| **twitterapi.io** (X collection, §1 / Module A) | `https://api.twitterapi.io` | `TwitterClient` / `TwitterApiSourceGateway` (`pnpm collect`), key `TWITTERAPI_IO_KEY` |
| **Lark IM API** (§1 / Module B collect, §2 / Module D drive) | `https://open.larksuite.com` (Feishu: `https://open.feishu.cn`) | `LarkAuth` / `LarkClient` (`pnpm collect-lark`), `LarkDriveUploader`. See `docs/guides/lark-setup-guide.md` |

> **No LLM/AI API is called at runtime.** Translation (§3) and content shaping (§5/§6) are
> performed by the operator's **local Claude agent** via worksheets, not a hosted model —
> so there is no model API key in the pipeline.

> **GitHub is dev/CI tooling only — never called at runtime.** The pipeline has no GitHub API
> client and no GitHub MCP. GitHub is used only around the repo: the `gh` CLI for PRs/CI locally,
> and GitHub Actions (`.github/workflows/ci.yml`) to run `test` on each PR.
