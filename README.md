# mantle-kr-herald

Social media automation pipeline for the Mantle KR team. See `docs/superpowers/specs/` for designs and `docs/architecture/hexagonal-architecture.md` for the architecture.

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

Output is written to `output/` (git-ignored): `items.json` (collected threads) and `state.json` (watermark).

## Module B — Lark data collection

Collects text/post messages from target Lark group chats into local JSON, incrementally per chat.

### Setup

See `docs/guides/lark-setup-guide.md` for how to create the Lark app and find `chat_id`s. Then fill `.env`:
`LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_CHAT_IDS` (comma-separated), and optionally `LARK_BASE_URL`.

### Commands

```bash
pnpm collect-lark       # collect new messages from all configured chats
```

Output is written to `output/` (git-ignored): `lark-items.json` and `lark-state.json` (per-chat watermarks).

## Module C — Korean translation (agent-assisted)

Assembles 6-element translation prompts from collected X/Lark content (shared context once per batch + per-item text) and stores agent-produced Korean translations, with a few-shot flywheel. The local Claude agent does the actual translation — no Claude API.

### Data

Living config in `data/` (git-tracked): `glossary.json`, `style-guide.md`, `locale.json`, `few-shot.json`. Edit these to steer tone/terminology.

### Commands

```bash
pnpm translate:prepare [--source x|lark] [--ids a,b] [--since <ISO>] [--limit 20]
#   → writes output/translation-batch-<ts>.md (worksheet) + output/translation-pending.json
#   → the agent translates each item's 원문 into its 번역 section
pnpm translate:save --id <itemId> --file <korean.txt> [--approve]   # ingest; --approve promotes to few-shot
pnpm glossary                                                       # list entries
pnpm glossary add --term <t> --rule <translate|transliterate|keep> [--target <ko>] [--source <url>]
```

Worksheets/translations are written to `output/` (git-ignored).

## Module D — Drive upload (Google + Lark)

Publishes C's translations to Google Drive and Lark Drive as Markdown: `translated` → source+Korean review docs, `approved` → Korean-only finals. Headless (coded REST), no Claude API.

### Setup

See `docs/guides/google-drive-setup-guide.md` (service account + `pnpm drive:init` which creates & shares the folders) and `docs/guides/lark-setup-guide.md` §10 (drive scope, folder tokens) — index at `docs/guides/drive-setup-guide.md`. Fill `.env`: `GOOGLE_SA_KEY_FILE`, `GDRIVE_SHARE_EMAILS`, `GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`, `LARK_DRIVE_REVIEW_FOLDER_TOKEN`, `LARK_DRIVE_APPROVED_FOLDER_TOKEN` (Lark app creds reused from Module B). Google uses least-privilege `drive.file` scope.

### Commands

```bash
pnpm drive:init                              # service account creates + shares the folders, prints IDs (idempotent; --force to recreate)
pnpm drive:publish [--target google|lark|both]
```

Idempotent per drive via `output/publish-state.json`.
