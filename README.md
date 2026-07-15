# mantle-kr-herald

Social media automation pipeline for the Mantle KR team. See `docs/superpowers/specs/` for designs and `docs/architecture/hexagonal-architecture.md` for the architecture. Release history is in [`CHANGELOG.md`](CHANGELOG.md).

## Module A — X data collection (twitterapi.io)

Collects `Mantle_Official`'s authored tweets (threads reconstructed) into local JSON, incrementally, with soft-mark deletion handling.

### Setup

```bash
pnpm install
cp .env.example .env   # then fill TWITTERAPI_IO_KEY
```

### Commands

```bash
pnpm collect            # collect new authored tweets (default @Mantle_Official)
pnpm collect <handle>   # collect a different account
pnpm reconcile          # re-check stored tweets; soft-mark deletions
pnpm test               # run unit tests
pnpm typecheck          # type-check
```

Output is written to `output/x/` (git-ignored): `items.json` (collected threads) and `state.json` (watermark).

## Module B — Lark data collection

Collects text/post messages from target Lark group chats into local JSON, incrementally per chat.

### Setup

See `docs/guides/lark-setup-guide.md` for how to create the Lark app and find `chat_id`s. Then fill `.env`:
`LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_CHAT_IDS` (comma-separated), and optionally `LARK_BASE_URL`.

### Commands

```bash
pnpm collect-lark       # collect new messages from all configured chats
```

Output is written to `output/lark/` (git-ignored): `items.json` and `state.json` (per-chat watermarks).

## Module C — Korean translation (agent-assisted)

Assembles 6-element translation prompts from collected X/Lark content (shared context once per batch + per-item text) and stores agent-produced Korean translations, with a few-shot flywheel. The local Claude agent does the actual translation — no Claude API.

### Data

Living config in `translation/` (git-tracked): `glossary.json`, `style-guide.md`, `locale.json`, `few-shot.json`. Edit these to steer tone/terminology.

### Commands

```bash
pnpm translate:prepare [--source x|lark] [--ids a,b] [--since <ISO>] [--limit 20]
#   → writes output/translations/worksheets/batch-<ts>.md (worksheet) + output/translations/pending.json
#   → the agent translates each item's 원문 into its 번역 section
pnpm translate:save --id <itemId> --file <korean.txt> [--approve]   # ingest; --approve promotes to few-shot
pnpm glossary                                                       # list entries
pnpm glossary add --term <t> --rule <translate|transliterate|keep> [--target <ko>] [--source <url>]
```

Worksheets/translations are written to `output/translations/` (git-ignored).

## Module D — Drive upload (Google + Lark)

Publishes C's translations to Google Drive and Lark Drive as Markdown: `translated` → source+Korean review docs, `approved` → Korean-only finals. Headless (coded REST), no Claude API.

### Setup

See `docs/guides/google-drive-setup-guide.md` and `docs/guides/lark-setup-guide.md` §10 (drive scope, folder tokens) — index at `docs/guides/drive-setup-guide.md`.

Google Drive auth has two methods (least-privilege `drive.file` scope either way): **OAuth** (recommended for a personal Gmail — files owned by you; run `pnpm google:auth` to mint `GOOGLE_OAUTH_REFRESH_TOKEN`) or **service account** (Google Workspace Shared Drive only — a service account has no storage quota so it can't upload to a personal Drive). Then `pnpm drive:init` creates & shares the folders. Fill `.env`: Google auth (`GOOGLE_OAUTH_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`, or `GOOGLE_SA_KEY_FILE` + `GOOGLE_AUTH_MODE=service_account`), `GDRIVE_SHARE_EMAILS`, `GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`, and `LARK_DRIVE_REVIEW_FOLDER_TOKEN`, `LARK_DRIVE_APPROVED_FOLDER_TOKEN` (Lark app creds reused from Module B).

### Commands

```bash
pnpm google:auth                             # one-time OAuth consent → prints GOOGLE_OAUTH_REFRESH_TOKEN (personal Gmail)
pnpm drive:init                              # creates + shares the folders, prints IDs (idempotent; --force to recreate)
pnpm drive:publish [--target google|lark|both]
```

Idempotent per drive via `output/publish/state.json`.

## Module E — Review dashboard (local)

A local web dashboard to review, edit, approve, and publish the Korean translations — the human-in-the-loop step between C (translation) and D (upload). A `node:http` server serves a React + Vite + Tailwind frontend plus a thin JSON API over the existing use-cases; it reads/writes the same `output/translations` stores as the CLIs, so the UI and CLI stay in sync. Local tool, no auth.

### Commands

```bash
pnpm build:web      # build the React frontend (Vite + Tailwind v4) → web/dist
pnpm serve          # start the dashboard on http://localhost:5757 (serves web/dist + JSON API)
pnpm dev:web        # (dev) Vite dev server with HMR, proxying /api to :5757
pnpm typecheck:web  # type-check the frontend
```

Open `http://localhost:5757`: list translations (filter by status), view source (`---` between thread tweets) + editable Korean, save / approve, and publish to Drive from the top bar.
