# mantle-kr-herald

Social media automation pipeline for the Mantle KR team. See `docs/superpowers/specs/` for designs, `docs/architecture/hexagonal-architecture.md` for the architecture, and [`docs/architecture/external-integrations.md`](docs/architecture/external-integrations.md) for the external APIs & MCP the project uses. Release history is in [`CHANGELOG.md`](CHANGELOG.md).

## Setup check

```bash
pnpm doctor          # which integrations are configured (offline; exits non-zero if any is missing)
pnpm doctor --live   # also mint tokens read-only and check OAuth scopes (e.g. Google drive.file / spreadsheets, Lark auth)
```

`--live` is the fast way to catch the scope gaps that otherwise surface as a cryptic mid-run error — e.g. a Google token missing the `spreadsheets` scope needed for the Sheet hub (§9a).

```bash
pnpm status          # how far data has flowed: collected → translated → converted → rendered → published (offline)
```

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

The dashboard has two review modes (header toggle): **1차 검수 (번역)** reviews Module C
translations, and **2차 검수 (채널)** reviews Module F channel renderings (§7) — list/filter by
status·channel·type, view the converted source, edit the channel text, approve, and copy the
approved text for manual posting. Renderings come from `pnpm format`; run it first if the list is empty.

## Module F — Content shaping (item conversion + channel formatting)

Turns an **approved** Korean translation (Module E) into channel-ready posts, in two stages.

### §5 Item conversion (agent-assisted, like translation)

```bash
pnpm convert:prepare [--types x,kol,pr] [--ids a,b] [--since <ISO>] [--limit 20]
#   → output/variants/worksheets/batch-<ts>.md — fill each 변환 section
pnpm convert:save --id <itemId> --type <x|kol|pr> --file <ko.txt> [--approve]
```

Per-type steering config lives in `conversion/` (`x.md`, `kol.md`, `pr.md`, `few-shot.<type>.json`);
it reuses `translation/glossary.json` and `translation/locale.json`. `--approve` feeds a per-type few-shot flywheel.

### §6 Channel formatting (deterministic code + optional agent refinement)

```bash
pnpm format [--types x,kol,pr] [--channels x,telegram,kakao,pr_mail] [--ids a,b] [--x-bold unicode] [--refine]
#   default: writes ChannelRenderings from the code formatter to output/formatted/renderings.json
#   --refine: writes a refinement worksheet for the agent to fine-tune, then:
pnpm format:save --id <itemId> --type <t> --channel <c> --file <txt>
```

Default channels per type: `x → x, kakao` · `kol → telegram` · `pr → pr_mail`.

## Module G — Google Sheet data hub (§9a)

A Google Sheet the team edits as the automation's data hub. §9a covers the foundation plus the first
two roles; **③ impressions is §9b** (later). Uses the direct Google Sheets v4 REST API with the same
Google auth as Drive — the OAuth token must include the `spreadsheets` scope (see
`docs/architecture/external-integrations.md`).

```bash
pnpm sheet:init      # create the spreadsheet (tabs: targets, history) → prints GSHEET_ID for .env
pnpm targets:list [--active-only]                          # ① read the distribution targets
pnpm history:record --item <id> --type <t> --channel <c> --status <s> [--post-id <p>] [--url <u>]  # ② record a publish
```

Two tabs: **`targets`** (`channel | name | address | active | notes`) — the team-maintained
distribution list (consumed later by §8/§10); **`history`**
(`itemId | type | channel | postId | url | status | publishedAt | impressions | impressionsAt`) —
publish log, upserted by `(itemId, type, channel)` (§8 will call `RecordPublish`; impressions columns
are filled by §9b).
