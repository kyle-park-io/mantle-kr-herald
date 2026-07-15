# Content Shaping (§5 Item Conversion + §6 Channel Formatting) — Design

**Status:** Approved design (2026-07-15)
**Depends on:** C (translation store, `SaveTranslation`, `translation/` config), the approved-translation output of §4 (1차 검수).

## Goal

Turn an **approved Korean translation** into channel-ready posts, in two automated stages
from the proposal (`design/social-media-automation-proposal.md`):

- **§5 Item conversion** — rewrite the approved Korean into item-type-specific copy
  (X post / KOL brief / PR release), agent-assisted, the same way as §3 translation.
- **§6 Channel formatting** — apply per-channel text formatting (bold, line breaks, limits)
  to a converted variant, deterministically in code, with an optional agent refinement pass.

Pipeline position:

```
… → [1차 검수 → approved translation] → §5 convert → §6 format → [2차 검수] → §8 upload
```

`[2차 검수]` (§7) and upload (§8) are **separate, out of scope here** — this work produces
and stores the converted variants and channel renderings; a later subsystem reviews and ships them.

## Concepts & data model

### §5 — `ContentVariant`

One approved translation fans out into one variant per selected **type**. Default is all
three types; the operator can select a subset.

```ts
type ConversionType = "x" | "kol" | "pr";

interface ContentVariant {
  itemId: string;            // "x:<rootId>" | "lark:<messageId>" — same id as the translation
  type: ConversionType;
  sourceKorean: string;      // the approved translation (input, for provenance/diffing)
  convertedText: string;     // agent-produced, type-specific Korean copy
  status: "converted" | "approved";
  createdAt: string;         // ISO
  approvedAt?: string;
}
```

- **Identity** of a variant is `(itemId, type)`.
- `convert:save --approve` promotes `converted → approved` and appends to that type's
  few-shot store (a per-type flywheel, mirroring §3).

### §6 — `ChannelRendering`

A converted variant is formatted for one or more **channels**.

```ts
type Channel = "x" | "telegram" | "kakao" | "pr_mail";

interface ChannelRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;              // channel-formatted output
  refined: boolean;          // false = code formatter only; true = agent-refined
  createdAt: string;
}
```

- **Identity** of a rendering is `(itemId, type, channel)`.
- The code formatter is deterministic; `refined` records whether an agent refinement pass
  edited the code output.

### Type ↔ channel default mapping

Type = "what is written"; channel = "how it is formatted". Types have a natural default
channel, but any variant may be formatted for any channel (operator selects with `--channels`).

| §5 type | default channel(s) |
| ------- | ------------------ |
| `x`     | `x` (+ `kakao` plain) |
| `kol`   | `telegram`         |
| `pr`    | `pr_mail`          |

## §5 conversion mechanism (agent-assisted, reuses the §3 pattern)

Directly mirrors the translation flow (`PrepareTranslations` / `SaveTranslation`,
`promptAssembler`, worksheet → agent fills → save → few-shot).

- **Input:** approved translations from `TranslationStore` (`status === "approved"`),
  minus the `(itemId, type)` pairs already converted (tracked by `ConversionStore`).
- **Steering config** in a new git-tracked **`conversion/`** folder:
  - `x.md`, `kol.md`, `pr.md` — per-type role + style notes (the ① role / ③ style elements).
  - `few-shot.x.json`, `few-shot.kol.json`, `few-shot.pr.json` — per-type examples (⑤).
  - **Reuses** `translation/glossary.json` (② terminology stays consistent across the pipeline)
    and `translation/locale.json` (④).
- **Worksheet:** one worksheet per prepare run, **sectioned by type**. Each section carries
  that type's shared context (role/glossary/style/locale/few-shot) once, then per-item blocks:

  ```
  ### <itemId>
  승인본:
  <approved Korean>
  변환:
  <agent fills here>
  ```

- **Use-cases:** `PrepareConversions` (selects approved, applies selector, assembles worksheet)
  and `SaveConversion` (ingests `변환` text; `--approve` promotes + appends to per-type few-shot).
- **Ports/adapters:**
  - `ConversionStore` (port) → `JsonConversionStore` (`output/variants/…`).
  - `ConversionConfig` (port) → `FileConversionConfig` (loads per-type `.md` + few-shot;
    reuses the existing glossary/locale stores).

## §6 formatting mechanism (deterministic code + optional agent refinement)

- **Domain:** pure functions `formatForChannel(text, channel): string` in `domain/formatting/`.
  Deterministic, no I/O — trivially unit-testable.
  - `x`: strip Markdown; `**bold**` → plain by default (unicode-bold opt-in via a formatter
    option); preserve hashtags, `@mentions`, links; warn when the result exceeds 280 chars
    (thread hint, not a hard fail).
  - `telegram`: MarkdownV2 — escape reserved characters, `**bold**` → `*bold*`, preserve links.
  - `kakao`: plain text — remove Markdown, normalize spacing (no rich formatting; API-less, manual upload).
  - `pr_mail`: subject + body structure; plain text (or simple HTML) suitable for a press email.
- **Storage:** `ChannelRendering` records in `output/formatted/`.
- **Optional agent refinement:** `format --refine` writes a refinement worksheet
  (code-formatted draft per `(variant, channel)`) for the agent to fine-tune; `format:save`
  ingests the refined text and stores it with `refined: true`. Without `--refine`, the code
  formatter output is stored directly (`refined: false`) and is usable as-is.
- **Ports/adapters:** `FormattingStore` (port) → `JsonFormattingStore` (`output/formatted/…`).

## CLI surface (4 new commands)

```bash
# §5
pnpm convert:prepare [--ids a,b] [--types x,kol,pr] [--since <ISO>] [--limit 20]
#   → output/variants/worksheets/batch-<ts>.md + output/variants/pending.json
pnpm convert:save --id <itemId> --type <x|kol|pr> --file <ko.txt> [--approve]

# §6
pnpm format [--ids a,b] [--types x,kol,pr] [--channels x,telegram,kakao,pr_mail] [--refine]
#   without --refine: writes ChannelRenderings from the code formatter
#   with --refine:     also writes output/formatted/worksheets/batch-<ts>.md for the agent
pnpm format:save --id <itemId> --type <t> --channel <c> --file <txt>
```

Defaults: `--types` → all three; `--channels` → each type's default-mapped channel(s).

## Storage layout (git-ignored `output/`)

```
output/variants/
  variants.json          # ContentVariant[]
  pending.json           # items selected by the last convert:prepare (id + type)
  worksheets/batch-*.md
output/formatted/
  renderings.json        # ChannelRendering[]
  worksheets/batch-*.md  # only when --refine
```

## Boundaries — out of scope (follow-ups)

- **§7 2차 검수** — extending the review dashboard (E) to list/edit/approve variants and
  renderings. This work gates only via CLI `--approve`.
- **§8 upload** — Telegram / PR-email automated sending, tweet/KakaoTalk manual.
- **Drive upload of variants** — not published to Google/Lark Drive here.
- **§9 Sheet hub / §10 bots** — later subsystems.

## Testing

- **Channel formatters** — pure-function unit tests per channel (Markdown in → channel rules out:
  bold handling, escaping, link/hashtag/mention preservation, kakao plain, X 280 warning).
- **Prompt assembler** — per-type worksheet assembly (correct shared context + item blocks).
- **`SaveConversion`** — ingest into `converted`, `--approve` → `approved` + per-type few-shot append.
- **Config loader** — `FileConversionConfig` loads per-type `.md`/few-shot and reuses glossary/locale.
- **Selectors** — `--types` / `--channels` / `--ids` filtering; already-converted exclusion.

## Build order (within one plan)

1. §5 domain + ports (`ConversionType`, `ContentVariant`, prompt assembler, store/config ports).
2. §5 adapters (`JsonConversionStore`, `FileConversionConfig`) + `conversion/` seed config.
3. §5 use-cases (`PrepareConversions`, `SaveConversion`) + CLIs (`convert:prepare`, `convert:save`).
4. §6 domain formatters (`formatForChannel` per channel) — pure, test-first.
5. §6 store + `format` CLI (code path) → `ChannelRendering`.
6. §6 `--refine` worksheet + `format:save` (agent refinement path).
