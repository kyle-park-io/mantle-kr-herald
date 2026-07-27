# §8 Channel delivery — Telegram bot + Typefully (X) — design

Date: 2026-07-27
Status: approved for planning
Scope: the two senders Kyle chose — **Telegram bot** and **Typefully (for X)**. No official X API, no
twitterapi.io write, no Kakao/mail sender (see Non-goals).

## Context

The pipeline renders approved channel copy but stops there: #50 built the six **destinations**
(`x_paste`/`x_typefully`/`telegram_paste`/`telegram_bot`/`kakao_paste`/`pr_mail`) and explicitly did
**no sending** ("No Telegram bot sender, no Typefully API, no X API"). The last mile — actually
posting an approved rendering to its channel — is still manual copy-paste. This is §8: a **delivery
layer** that sends the API-destination spelling of an approved rendering to the real channel, and
records the result so §9's `history`/impressions loop finally has data to process.

**The emitters already produce exactly what a sender needs.** `emit(canonical, destination)` returns
`EmitResult{ segments: EmitSegment[] }` — the channel-correct spelling, already split into posts.
`DESTINATIONS_BY_CHANNEL` maps each channel to its destinations; the **API** destination of each is
what §8 delivers: `telegram → telegram_bot` (HTML), `x → x_typefully` (plain posts). So a sender is
pure transport over strings the emitter already spelled — no formatting logic in §8.

**Why Typefully for X, not the X API or twitterapi.io write** (decided with Kyle): the KR official
account @0xMantleKR is a brand asset. twitterapi.io *can* write (via a login-session + residential
proxy) but its own docs warn of account suspension — unacceptable ban risk on the official account.
The official X API is sanctioned but needs a developer app + OAuth-user-context write + tier setup.
Typefully is a sanctioned integration that posts to X for us via a bearer-token API — lowest risk,
and the `x_typefully` destination already exists for it.

## Decisions

### 1. A `ChannelSender` port + per-channel adapters, mirroring `DriveUploader`

```ts
interface ChannelSender {
  send(req: SendRequest): Promise<SendResult>;
  readonly name: string; // "telegram" | "x" — stable key for the ledger + reporting
}
interface SendRequest { itemId: string; type: string; channel: SendableChannel; segments: string[]; }
interface SendResult { postId?: string; url?: string; status: "posted" | "failed"; }
```

`segments` are the emitter's per-post strings, already spelled for the destination. The sender is
transport only; it never emits or formats. `SendableChannel = "telegram" | "x"`.

### 2. `TelegramBotSender` — Bot API, HTML, one message per segment

`POST https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage` with
`{ chat_id: TELEGRAM_CHAT_ID, text: segment, parse_mode: "HTML" }`, once per segment (a multi-segment
rendering becomes sequential messages; each after the first uses `reply_to_message_id` of the first
so they visually chain). `text` is capped at 4096 chars **after entity parsing** — the `telegram_bot`
emitter already segments to the limit, so a sender that receives an over-limit segment reports it
rather than silently truncating. Result: `postId` = the first message id, `url` =
`https://t.me/c/<internal>/<id>` when derivable, else the message id. `name = "telegram"`.

### 3. `TypefullySender` — v2 draft published now, poll for the X url

- Auth `Authorization: Bearer <TYPEFULLY_API_KEY>` (v2 key from typefully.com → Settings → API).
- `POST https://api.typefully.com/v2/social-sets/<TYPEFULLY_SOCIAL_SET_ID>/drafts` with
  `{ platforms: { x: { enabled: true, posts: segments.map(text => ({ text })) } }, publish_at: "now" }`.
  The `posts` array **is** the thread — one entry per segment.
- Publishing "now" may be asynchronous, so poll `GET /v2/social-sets/<id>/drafts/<draft_id>` until
  `x_published_url` is present (bounded retries with a short backoff); return it as `url`, the draft
  id as `postId`. If the poll times out, return `status:"posted"` with the draft id and a warning
  (the draft is created; the url just wasn't confirmed in time) — never a duplicate re-post.
- `name = "x"`. `TYPEFULLY_SOCIAL_SET_ID` is configured explicitly (list them with
  `GET /v2/social-sets`); resolving by handle is a later nicety.

### 4. `SendChannels` use-case — approved, unsent, per-item isolation, idempotent

For each approved `ChannelRendering` (`status === "approved"`) whose `channel` is in the requested
targets and is **not already in the channel ledger** (idempotency): compute the delivery destination
(`telegram → telegram_bot`, `x → x_typefully`), `emit()` it to segments, `sender.send(...)`, then
record. A per-item try/catch isolates failures — one bad send does not sink the batch; the run
reports `sent / skipped / failed`.

### 5. Idempotency via a local channel ledger; history is the cloud add-on

A send is a one-shot irreversible action, so **never double-post**. The guard is a local ledger
`output/publish/channels.json`, a row per `(itemId, type, channel)` → `{ postId, url, sentAt,
senderName }`. A rerun skips any rendering already in it. This is separate from the Drive sync ledger
(`output/publish/state.json`, which keys by upload target) — channels are a different axis.

Recording to the Sheet `history` tab via `RecordPublish` (so §9b impressions can run) is **cloud-only
and best-effort**: attempted when `GSHEET_ID` + cloud auth are available, wrapped so a missing sheet
never fails a successful send. The local ledger is the source of truth for "already sent"; `history`
is the analytics feed. So §8 works in **any storage mode** (Telegram/Typefully need only their own
tokens) — it is **not** `skipIfLocal`-gated, unlike the Sheet commands.

### 6. `send:channels` CLI — target selection like `drive:publish`

`pnpm send:channels [--target telegram|x|both] [--ids <id,...>]`. `resolveChannelTargets` mirrors
`resolveTargets`: `both` = all sendable channels; default = all. `createSenders(targets)` builds only
the requested senders (so a Typefully-less setup can still send Telegram). Reports
`sent N · skipped M (already sent) · failed K`, and prints each failure's reason.

## Architecture

- **Domain:** `SendableChannel`, `DELIVERY_DESTINATION` map (`telegram → telegram_bot`,
  `x → x_typefully`), and the ledger row type in `src/domain/publish/` (or `src/domain/send/`).
- **Port:** `src/ports/ChannelSender.ts`.
- **Adapters:** `src/adapters/send/TelegramBotSender.ts`, `src/adapters/send/TypefullySender.ts`
  (both take an injected `fetch` for testing, like `GoogleSheetClient`). Response parsing via `zod`.
- **App:** `SendChannels` use-case (`src/app/SendChannels.ts`) — reads `FormattingStore`
  (renderings.json), emits, sends, writes the channel ledger, best-effort `RecordPublish`.
- **Store:** `JsonChannelLedger` (`output/publish/channels.json`) — load/upsert by
  `(itemId, type, channel)`.
- **CLI:** `src/cli/send-channels.ts` + `src/cli/channelSenders.ts` (`resolveChannelTargets` /
  `createSenders`), mirroring `src/cli/uploaders.ts`.
- **Config:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; `TYPEFULLY_API_KEY`,
  `TYPEFULLY_SOCIAL_SET_ID`. Loaders in `src/config.ts`.
- **Reuse:** `emit`/`DESTINATIONS_BY_CHANNEL`, `FormattingStore`, `RecordPublish`/`PublishRecord`,
  `parseList`/`argValue`, `registerErrorHandler`, the `resolveTargets` pattern.

### Data flow

```
send:channels --target both
  │  FormattingStore.load() → renderings where status="approved" and channel ∈ {telegram, x}
  │  minus rows already in output/publish/channels.json (idempotency)
  ▼  per rendering
  emit(canonical, DELIVERY_DESTINATION[channel]) → EmitResult.segments → string[]
  ▼
  sender.send({ itemId, type, channel, segments })
     telegram → Bot API sendMessage per segment (HTML)
     x        → Typefully draft (posts=[…], publish_at:"now") → poll x_published_url
  ▼  on success
  channels.json upsert {postId,url,sentAt,senderName}   (always)
  RecordPublish → history tab {itemId,type,channel,postId,url,"posted",publishedAt}  (cloud, best-effort)
```

## Error handling

- A missing token for a requested channel fails that channel's construction with a clear
  `✖ <channel>: set <VAR>` (via `registerErrorHandler`), before any send.
- A send HTTP error (Telegram non-ok, Typefully non-ok) marks that item `failed`, logs the API's
  error body, and continues; the item is **not** written to the ledger, so a later rerun retries it.
- An over-limit segment reaching a sender (should not happen — the emitter caps it) is reported as a
  failed item, never truncated.
- Typefully poll timeout → `posted` with the draft id + a warning (created, url unconfirmed); the
  ledger records it so no duplicate is ever posted.
- `RecordPublish` failure (no sheet / not cloud) is swallowed with a note — the send already
  succeeded and is in the local ledger.

## Testing

- `TelegramBotSender` (injected fetch) — one segment → one sendMessage with `parse_mode:"HTML"` and
  the chat id; three segments → three calls, the 2nd/3rd carrying `reply_to_message_id` of the 1st; a
  non-ok response → `status:"failed"` with the error surfaced.
- `TypefullySender` (injected fetch) — segments → a `posts` array of that length with `publish_at:"now"`
  and the bearer header; a create then a poll that returns `x_published_url` → that url; a poll that
  never resolves within the cap → `posted` + warning, id retained; non-ok create → `failed`.
- `SendChannels` (fake store + fake senders + fake ledger) — sends only `approved` renderings; skips a
  rendering already in the ledger (no second send); a sender that throws marks that item failed and
  the others still send; writes the ledger row on success; the counts are exact.
- `resolveChannelTargets` — `both`/default/explicit/unknown-token, mirroring the uploaders test.
- Every assertion pins concrete values; senders are tested with a fake `fetch`, never a live call.

## Non-goals

- **Official X API and twitterapi.io write** — X goes through Typefully only (ban-risk decision).
- **Kakao and pr_mail senders** — Kakao has no post API (stays copy-paste); mail (SMTP) is later.
- **Media/images** — text posts only for v1 (Typefully + Telegram both support media; deferred).
- **Scheduling** — publish now only (`publish_at:"now"`); `next-free-slot`/ISO are a later option.
- **A dashboard send button** — CLI only for v1; the dashboard already approves.
- **Editing/deleting a sent post** — a send is final; corrections are manual.

## Global constraints

- Runtime deps stay zod-only (response parsing uses `zod`; HTTP uses `fetch`).
- Works in **any** storage mode — channel senders need only their own tokens; `history` recording is
  the cloud-only, best-effort add-on. Not `skipIfLocal`-gated.
- **Never double-post:** the local channel ledger gates every send; a failed send is not ledgered so
  it retries, a succeeded send is ledgered so it never repeats.
- Public repo: tokens live only in `.env`; tests use synthetic data + injected `fetch`, never a live
  call or a real token.

## Open items to verify live (Kyle provides creds; not blockers to planning)

- **Telegram:** a bot (via BotFather) added to the target channel as an **admin**, its
  `TELEGRAM_BOT_TOKEN`, and the channel `TELEGRAM_CHAT_ID` (a bot can only post to a chat/channel it
  is in). Confirm the `t.me/c/...` url shape for a channel post.
- **Typefully:** a Typefully account with @0xMantleKR connected, a **v2** API key, and the
  `social_set_id` (`GET /v2/social-sets`). Confirm whether `publish_at:"now"` is async in practice and
  the exact `x_published_url` field on the draft-get response.
- Whether the `telegram_bot` emitter's HTML actually renders as expected in the destination channel
  (the #50 spec flagged client-paste parsing as unverified; the **bot** path uses `parse_mode:"HTML"`
  which the Bot API does parse, so this should hold — confirm on the first real send).
