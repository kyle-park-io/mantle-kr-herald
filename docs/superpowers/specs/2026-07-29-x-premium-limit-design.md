# X Premium-aware tweet limit — Design

**Date:** 2026-07-29
**Branch:** `feat/x-premium-limit` (off `main`)
**Status:** approved for planning

## Motivation

The pipeline models X's **standard** 280-weighted tweet limit (`X_MAX_WEIGHTED = 280`, Korean/CJK
weigh 2 each, so ~140 Korean chars). But `@Mantle_Official` — and the send/test account `@bcd_kyle`
— are **X Premium**, which allows **long-form posts up to 25,000 characters**. So Mantle's genuine
long-form tweets (e.g. `x:2080608995371597892` EN 418 chars, `x:2081711456320655644` EN 459 chars)
have Korean renderings of 358 / 476 weighted — legitimately over 280 — and the pipeline's over-limit
handling treats them as errors:

- **`SendChannels`'s over-limit guard fail-fasts them** (`emitResult.segments.some(overLimit)` →
  `failed++`, `continue`), so a long-form post is **blocked before it is ever sent**, even though
  the Premium account could post it.
- `format` warnings, the refinement worksheet, and the dashboard emissions all show a false
  `N/280 (초과)`.

**Fix:** make the x-channel weighted limit **account-aware** — Premium ⇒ 25,000, standard ⇒ 280 —
driven by one env flag. "롱폼 되면 롱폼으로, 안 되면 280 아래로."

## Approach

A single opt-in env flag **`X_PREMIUM`** (the pipeline serves one brand account, so a global flag
fits — the account either is Premium or is not). When `true`, the x weighted limit becomes
`X_PREMIUM_MAX_WEIGHTED = 25000`; otherwise it stays `X_MAX_WEIGHTED = 280` (default — a non-Premium
user is never surprised by an X-rejected long tweet). The resolved limit threads to the one place it
matters — `emitX`'s `overLimit`/warning computation — via an **optional `xMaxWeighted` parameter
that defaults to `X_MAX_WEIGHTED`**, so every existing call and test is byte-for-byte unchanged.

**Behavior:**
- content ≤ limit → normal single tweet (either mode)
- content over 280, ≤ 25,000, `X_PREMIUM=true` → **single long-form tweet** (Premium only)
- content with `\n\n\n` post boundaries → thread (each tweet measured against the same limit)
- **No auto-threading** of long content — Mantle's originals are single long-form tweets; the
  faithful rendering is one long tweet, not a machine-split thread.

## Design

### Constants (`src/domain/formatting/weightedLength.ts`)

Add `export const X_PREMIUM_MAX_WEIGHTED = 25000;` (X Premium long-post max). `X_MAX_WEIGHTED = 280`
stays the default/standard.

### Config (`src/config.ts`)

```ts
export function loadXMaxWeighted(): number {
  return process.env.X_PREMIUM?.trim() === "true" ? X_PREMIUM_MAX_WEIGHTED : X_MAX_WEIGHTED;
}
```
Add `X_PREMIUM` to `.env.example` with a comment (default false; set true when the posting X account
is Premium — enables long-form ≤25,000 for x sends).

### Emit threads an optional limit

- `emitters/x.ts`: `emitX(canonical: string, xMaxWeighted: number = X_MAX_WEIGHTED)` — uses
  `xMaxWeighted` in `overLimit = length > xMaxWeighted`, the `EmitSegment.limit`, and the warning
  text. `emitXPaste`/`emitXTypefully` keep pointing at `emitX` (both x destinations obey the flag —
  same brand account).
- `emitters/types.ts`: the `EMITTERS` value type widens to
  `(canonical: string, xMaxWeighted?: number) => EmitResult`. The non-x emitters
  (`emitKakaoPaste`, `emitTelegram*`, `emitPrMail`) keep their single-param signatures — a function
  taking fewer params satisfies the wider type, and they simply ignore the extra arg.
- `emitters/index.ts`:
  ```ts
  export function emit(canonical, destination, xMaxWeighted = X_MAX_WEIGHTED): EmitResult {
    return EMITTERS[destination](stripMedia(canonical), xMaxWeighted);
  }
  export function emitAll(canonical, channel, xMaxWeighted = X_MAX_WEIGHTED) {
    // ...for each destination: emit(canonical, destination, xMaxWeighted)
  }
  ```
  (`stripMedia` strip from the media-in-source feature stays.)

### Callers pass the resolved limit (default keeps 280)

The limit is resolved from config at the CLI/adapter boundary and injected inward — domain functions
never read `process.env`:

- **`SendChannels`** (`src/app/SendChannels.ts`): new ctor field `xMaxWeighted: number = X_MAX_WEIGHTED`
  (append after the existing params), used in `emit(r.text, DELIVERY_DESTINATION[r.channel], this.xMaxWeighted)`.
  **This is the load-bearing change** — it stops the long-form fail-fast.
- **`FormatVariants`** (`src/app/FormatVariants.ts`): new ctor field `xMaxWeighted = X_MAX_WEIGHTED`,
  passed to `emitAll(text, channel, this.xMaxWeighted)`.
- **`refinementWorksheet`** (`src/domain/formatting/refinementWorksheet.ts`): new param
  `xMaxWeighted = X_MAX_WEIGHTED`, passed to `emit(draft, …, xMaxWeighted)`; its own header line that
  prints the x limit uses it too so the worksheet never contradicts the guard.
- **`apiHandlers`** (`src/adapters/web/apiHandlers.ts`): the emissions route passes an
  `xMaxWeighted` (resolved in `serve.ts` from `loadXMaxWeighted()`, threaded via `ApiDeps`) to
  `emitAll(existing.text, channel, xMaxWeighted)`.
- **CLIs** (`src/cli/{send-channels,format,serve}.ts`): call `loadXMaxWeighted()` and inject into
  `SendChannels` / `FormatVariants` + `refinementWorksheet` / `apiHandlers`.

## Non-goals

- Premium+ / other tiers, or a higher-than-25,000 cap.
- Auto-detecting an account's Premium status (manual flag only).
- Auto-threading long content into multiple tweets.
- Changing the standard 280 default, or the telegram/kakao/pr_mail limits.
- Per-destination divergence (x_paste vs x_typefully) — one flag governs both x destinations.

## Testing

- `loadXMaxWeighted`: `X_PREMIUM=true` → 25000; unset / `"false"` / other → 280 (use a crafted env,
  never the real `.env`).
- `emitX` (via `emit`): a 476-weighted x post with `xMaxWeighted=25000` → `overLimit=false`,
  `limit=25000`, no warning; with the default (280) → `overLimit=true` (existing behavior preserved).
- `emit`/`emitAll`: the `xMaxWeighted` arg reaches the x emitter; a telegram/kakao destination is
  unaffected by it.
- `SendChannels`: an approved x rendering that is 476 weighted **sends** (not fail-fast) when
  `xMaxWeighted=25000`; still fail-fasts at the 280 default. (Fakes; no live call.)
- `FormatVariants`: warnings for an x rendering use the injected limit (no false 초과 at 25000).
- Existing emitter / SendChannels / FormatVariants / refinementWorksheet tests stay green (default
  arg = 280).
- Full `pnpm test` green; `pnpm exec tsc --noEmit` clean.

## Operational (after merge, manual)

Set `X_PREMIUM=true` in `.env`, then re-run the paused E2E send: `send:channels --target x` now posts
the two long-form keepers (358 / 476 weighted) to `@bcd_kyle` as single long-form tweets. **Verify
during the live send that Typefully actually publishes a >280 post as long-form on the Premium
account** (it posts via the X API, which accepts long-form for Premium) — this is the one
implementation-time unknown.

## Files touched

- **Modify:** `src/domain/formatting/weightedLength.ts` (constant), `src/config.ts` (`loadXMaxWeighted`),
  `src/domain/formatting/emitters/{x.ts,index.ts,types.ts}`,
  `src/domain/formatting/refinementWorksheet.ts`, `src/app/{SendChannels.ts,FormatVariants.ts}`,
  `src/adapters/web/apiHandlers.ts`, `src/cli/{send-channels.ts,format.ts,serve.ts}`, `.env.example`
- **Tests:** `config` (`loadXMaxWeighted`), `emitters/x` (+ `index`), `SendChannels`, `FormatVariants`
