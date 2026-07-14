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

See `docs/lark-setup-guide.md` for how to create the Lark app and find `chat_id`s. Then fill `.env`:
`LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_CHAT_IDS` (comma-separated), and optionally `LARK_BASE_URL`.

### Commands

```bash
pnpm collect-lark       # collect new messages from all configured chats
```

Output is written to `output/` (git-ignored): `lark-items.json` and `lark-state.json` (per-chat watermarks).
