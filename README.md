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