# `pnpm doctor` — setup diagnosis — Design

**Status:** Approved design (2026-07-16). Part of the hardening pass (theme 3 of 4).

## Goal

One command that tells an operator **what's configured and what's missing/wrong** across the
project's integrations — so setup problems (and especially the OAuth **scope** gaps we hit
repeatedly: Lark `im:message.group_msg`, Google Sheets `spreadsheets`) are caught up front instead
of via a cryptic error mid-run.

## Behavior

`pnpm doctor [--live]` runs a set of checks, prints a ✓/⚠/✗ report + a summary line, and exits
non-zero if any check **fails** (so scripts/CI can gate on it). Warnings don't fail.

- **Config checks (default, offline, no network):** wrap each existing `load*Config` in try/catch —
  `ok` if it loads, `fail` with the loader's own error message otherwise. Covers: twitterapi (A),
  Lark app (B), Lark Drive (D), Google auth (mode), Google Drive (D), Google Sheet (§9a).
- **Live checks (`--live`, network, read-only):**
  - **Google:** `createGoogleAuth(...).getToken()` → GET `oauth2.googleapis.com/tokeninfo` → report the
    **granted scopes**; `drive.file` missing → warn (Drive), `spreadsheets` missing → warn (Sheets),
    each with the exact fix hint (`GOOGLE_OAUTH_SCOPE` + `pnpm google:auth`).
  - **Lark:** mint a tenant token (auth OK) + list chats (bot membership / chat count). The
    `im:message.group_msg` read scope is noted as verified by `pnpm collect-lark` (can't be probed
    without reading real messages).
  - **twitterapi:** config-only (a live call costs a request) — noted "verified by `pnpm collect`".

## Structure

- `src/doctor/report.ts` (pure, tested): `CheckResult { name; status: "ok"|"warn"|"fail"; detail }`,
  `summarize(results)`, `formatReport(results, { live })`.
- `src/doctor/checks.ts` (pure, tested): `configCheck(name, run, okDetail?)` (higher-order — runs a
  loader, catches), `parseScopes(scope)` (space-separated → array), `scopeCheck(name, granted, needed,
  hint)` (ok/warn).
- `src/cli/doctor.ts` (thin, untested like other CLIs — verified by typecheck + a manual run): wires
  the config checks with the real loaders and the live checks' network calls, then prints
  `formatReport`.

## Scope

**In:** the offline config checks for all integrations; `--live` Google scope check + Lark token/chat
check; the report/summary + non-zero exit on fail; `doctor` pnpm script.

**Out:** twitterapi live probe (cost); auto-probing the Lark `group_msg` scope; auto-remediation
(doctor reports + hints, it doesn't fix).

## Testing

- `report.ts`: `summarize` counts; `formatReport` renders glyphs + summary.
- `checks.ts`: `configCheck` ok/fail (fake run fn), `parseScopes` split, `scopeCheck` ok-when-granted /
  warn-with-hint.
- CLI: `pnpm typecheck` + a manual `pnpm doctor` / `pnpm doctor --live` run.

## Execution

Small tool (report + checks + CLI + tests) — built directly with TDD, not the full plan+subagent cycle.
