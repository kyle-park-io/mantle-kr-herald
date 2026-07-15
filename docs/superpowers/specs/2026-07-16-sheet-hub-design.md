# Google Sheet data hub — §9a (foundation + ①targets + ②history) — Design

**Status:** Approved design (2026-07-16)
**Depends on:** the existing Google auth (`TokenSource` / `createGoogleAuth`, `src/adapters/drive/`).
**Part of:** §9 (Google Sheet data hub). This is sub-project **§9a**; **§9b** (③ impressions) is a
separate later cycle.

## Goal

A Google Sheet that the Mantle KR team edits as the automation's **data hub** (proposal §9). §9a
builds the foundation and the first two of the three roles:

- **① Distribution targets (input)** — a `targets` tab the team maintains (Telegram groups, KOLs,
  PR media…); the pipeline reads it. Consumed later by §8 (upload) / §10 (bots).
- **② Publish history (output)** — a `history` tab the pipeline appends to (what was posted, where,
  when, with what link/status). §8 will call this; §9a provides the use-case + a manual CLI.

**③ Impressions (output)** is out of scope here — it's §9b (a later cycle, X-only first, per-row
graceful skip when a count can't be fetched). §9a only reserves the `impressions` columns in the
`history` header.

## Architecture

Direct **Google Sheets v4 REST API**, mirroring the Drive adapter: every call carries a Bearer
token from the existing `TokenSource` (`createGoogleAuth` → OAuth or service-account). No MCP, no new
runtime dependency (native `fetch`, `zod`-only). A Google Sheet is a Drive file, so — like the Drive
fix — **OAuth user-delegation owns the sheet and personal Gmail works (no Workspace)**; the OAuth
refresh token must include the `https://www.googleapis.com/auth/spreadsheets` scope (add it to
`GOOGLE_OAUTH_SCOPE` and re-run `pnpm google:auth`). See
`docs/architecture/external-integrations.md`.

### Spreadsheet layout — one spreadsheet, two tabs

- **`targets`** — header: `channel | name | address | active | notes`
  - `channel`: destination kind (e.g. `telegram`, `x`, `pr_mail`, `kol`) — free text (human-maintained).
  - `address`: the concrete destination (chat_id / handle / email).
  - `active`: `TRUE`/`FALSE` (case-insensitive) — inactive rows are skipped by readers.
- **`history`** — header:
  `itemId | type | channel | postId | url | status | publishedAt | impressions | impressionsAt`
  - Identity of a row is `(itemId, type, channel)`.
  - `impressions` / `impressionsAt` stay blank in §9a (populated by §9b).

## Data model (domain)

```ts
interface DistributionTarget {
  channel: string;   // telegram | x | pr_mail | kol | …  (human-maintained)
  name: string;
  address: string;   // chat_id | handle | email
  active: boolean;
  notes?: string;
}

interface PublishRecord {
  itemId: string;
  type: string;      // x | kol | pr (the §5 ConversionType, kept as string at this boundary)
  channel: string;   // x | telegram | kakao | pr_mail
  postId?: string;   // the channel's message/post id (used later by §9b impressions)
  url?: string;
  status: string;    // e.g. "posted" | "failed"
  publishedAt: string; // ISO
}
```

## Ports & adapters

- **`SheetClient`** (port) — the minimal Sheets surface the use-cases need:
  - `getValues(range): Promise<string[][]>` — read a tab/range.
  - `appendValues(range, rows): Promise<void>` — append rows.
  - `updateValues(range, rows): Promise<void>` — overwrite a range (used by upsert + §9b).
  - `createSpreadsheet(title, tabs): Promise<{ spreadsheetId: string }>` — for `sheet:init`.
- **`GoogleSheetClient`** (adapter) — implements `SheetClient` over `sheets.googleapis.com/v4`
  (`POST /v4/spreadsheets`, `GET …/values/{range}`, `…/values/{range}:append`,
  `PUT …/values/{range}`), authed by `TokenSource`. Mirrors `GoogleDriveUploader`'s
  token+fetch+error-check shape.

## Use-cases (app)

- **`LoadTargets`** — `run(): Promise<DistributionTarget[]>`. Reads the `targets` range, maps rows to
  the model (skips the header row and blank rows). Whether it filters `active` is a `run` option
  (default: return all; the CLI can `--active-only`).
- **`RecordPublish`** — `record(rec: PublishRecord): Promise<void>`. **Upsert by `(itemId, type,
  channel)`**: `getValues` the `history` tab to locate a matching data row; if found, overwrite only
  the **publish columns A–G** of that row (`updateValues` at `history!A{row}:G{row}`), leaving the
  `impressions` / `impressionsAt` columns (H, I) untouched so §9b's data survives a re-record; else
  `appendValues` a new A–G row. This keeps re-runs idempotent (a re-post updates the row rather than
  duplicating).

## CLIs

- `pnpm sheet:init` — create the spreadsheet with the two tabs + header rows via OAuth; print the
  `GSHEET_ID` to put in `.env`. (Owned by the user; share with the team via the Sheets UI, or reuse
  the Drive-style share later.) Idempotent is **not** required for v1 — it prints the new id each run.
- `pnpm targets:list [--active-only]` — read and print the targets (verifies the sheet + auth + scope).
- `pnpm history:record --item <id> --type <t> --channel <c> --status <s> [--post-id <p>] [--url <u>]`
  — append/upsert one history row (manual use + the exact use-case §8 will call).

## Config

- `GSHEET_ID` — the spreadsheet id (from `sheet:init`). `loadGoogleSheetConfig()` reads it (throws a
  clear error if missing), mirroring the other `load*Config` helpers. Google auth reuses
  `loadGoogleAuthConfig()` / `createGoogleAuth`.

## Scope

**In (§9a):** the `SheetClient` port + `GoogleSheetClient` adapter; `sheet:init`; `LoadTargets` +
`targets:list`; `RecordPublish` (upsert) + `history:record`; `GSHEET_ID` config.

**Out:** ③ impressions (§9b); §8 wiring (§8 will call `RecordPublish`); auth/scope UI (documented,
manual); sheet sharing automation (manual for v1).

## Testing

- **`GoogleSheetClient`** — value parsing (A1 range → `string[][]`), append/update request bodies,
  create-spreadsheet body, error handling on non-2xx. Inject `fetch` (like `GoogleDriveUploader`).
- **`LoadTargets`** — rows → `DistributionTarget[]` (header skipped, blank rows skipped, `active`
  parsed case-insensitively; `--active-only` filter).
- **`RecordPublish`** — append when new; overwrite the right row when `(itemId,type,channel)` exists
  (upsert), against a fake `SheetClient`.
- **Config** — `loadGoogleSheetConfig` reads `GSHEET_ID` / throws when missing.
- `sheet:init` / CLIs — `pnpm typecheck` + a manual smoke run (no unit tests for CLIs, matching the
  existing pattern).

## Build order (one plan)

1. `SheetClient` port + `GoogleSheetClient` adapter (REST) + tests.
2. `GSHEET_ID` config loader + test.
3. Domain models (`DistributionTarget`, `PublishRecord`).
4. `LoadTargets` use-case + `targets:list` CLI + tests.
5. `RecordPublish` use-case (upsert) + `history:record` CLI + tests.
6. `sheet:init` CLI (create spreadsheet + tabs + headers) + wiring; manual smoke.
7. Docs: README (Module G / §9a) + CHANGELOG + `.env.example` (`GSHEET_ID`, Sheets scope note).
