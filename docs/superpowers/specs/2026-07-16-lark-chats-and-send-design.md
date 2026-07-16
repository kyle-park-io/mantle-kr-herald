# Lark chat listing + message send — design

**Date:** 2026-07-16
**Status:** approved
**Scope:** subsystem B/§10 foundation — two small Lark CLIs

## Context

Lark's four primitives are all live-verified (read messages, list chats, create group, send
message). Only **read** is productionized (`collect-lark`); `LarkClient` exposes `get` only. This
adds the two we still want as real code:

1. `lark:chats` — list the chats the bot is in (id + name). A dev utility: filling `LARK_CHAT_IDS`
   in `.env` currently requires a raw API call or reading `doctor --live` (which only counts chats).
2. `lark:send` — send a text message to a chat. The **foundation for §10** (H. Bots — Lark internal
   bot auto-posts content). This ships the send path only; wiring approved pipeline content into it
   is deferred (Lark is not yet a §6 formatting channel).

Both send/read scopes are already granted (`im:message.group_msg`, and sending works — verified
live). No new OAuth scope, runtime dependency, or config is introduced.

## Principles

- Hexagonal, mirroring the existing Lark adapters: **port → adapter → (app use-case) → cli**.
- Reuse `loadLarkConfig()` (appId / appSecret / baseUrl / chatIds), `LarkAuth`, `LarkClient`,
  `registerErrorHandler`, and `src/cli/args.ts` (`argValue`).
- `zod`-only; validate every API envelope and throw on `code !== 0` (as `parseMessagesData` does).

## #1 — `lark:chats` (list chats)

A pure read utility; the CLI calls the adapter directly (no use-case), like `doctor`.

- **Domain** `src/domain/larkChat.ts`: `interface LarkChatSummary { chatId: string; name: string }`.
- **Port** `src/ports/LarkChatGateway.ts`: `listChats(): Promise<LarkChatSummary[]>`.
- **Adapter** `src/adapters/lark/LarkChatGateway.ts` (implements the port): paginates
  `GET /open-apis/im/v1/chats` (`page_size=100`, `page_token`) via `LarkClient.get`, mapping each
  item to `{ chatId, name }`. Gathers all pages, returns the array.
- **Schema** `src/adapters/lark/schemas.ts` → add `parseChatsData(response)`: validates the
  `{ code, msg, data: { items[], page_token?, has_more? } }` envelope, throws on `code !== 0`,
  returns `{ items, pageToken, hasMore }` (mirrors `parseMessagesData`). Chat items are validated
  with a small `ChatRaw` zod object (`chat_id`, `name` — `name` optional, defaults to `""`).
- **CLI** `src/cli/lark-chats.ts` (`pnpm lark:chats`): prints one line per chat, `chatId  name`;
  prints a friendly note if the bot is in no chats.

## #2 — `lark:send` (send a text message)

- **`LarkClient.post<T>(path, body)`** — new method mirroring `get`: fetch a tenant token, POST via
  the per-call `HttpClient`, and on a Lark auth-error code (99991661/99991663/99991664) refresh the
  token once and retry. (`HttpClient.post` already exists; the send query `?receive_id_type=chat_id`
  rides in the path string — `HttpClient` preserves an existing query and adds no params.)
- **Port** `src/ports/LarkMessageSender.ts`: `sendText(chatId: string, text: string): Promise<string>`
  (resolves to the created `message_id`).
- **Adapter** `src/adapters/lark/LarkMessageSender.ts` (implements the port): builds
  `{ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }`, calls
  `LarkClient.post("/open-apis/im/v1/messages?receive_id_type=chat_id", body)`, parses with
  `parseSendResult`, returns the `message_id`.
- **Schema** `src/adapters/lark/schemas.ts` → add `parseSendResult(response)`: validates
  `{ code, msg, data: { message_id } }`, throws on `code !== 0`, returns the `message_id`.
- **App use-case** `src/app/SendLarkMessage.ts`: `run(chatId, text): Promise<{ messageId: string }>`.
  Thin now (delegates to the sender), but it is the **§10 growth seam** — later this is where
  content selection, idempotency, and `RecordPublish` wiring will live.
- **CLI** `src/cli/lark-send.ts` (`pnpm lark:send --chat <id> --text <...>`): `--text` is required
  (throw a clear message if missing); `--chat` defaults to `loadLarkConfig().chatIds[0]` when
  omitted (throw if there is no configured chat). On success prints
  `sent message <message_id> to <chatId>`.

Message type is **text only** for v1 (YAGNI). Rich `post`/card messages can be added later behind
the same port without changing consumers.

## Wiring / packaging

- `package.json` scripts: `"lark:chats"` and `"lark:send"` (both
  `tsx --env-file-if-exists=.env src/cli/<name>.ts`).
- CHANGELOG `[Unreleased] → Added`: the two commands.

## Testing (TDD)

- **schemas**: `parseChatsData` (maps items, paginates fields, throws on `code !== 0`, tolerates a
  missing `name`); `parseSendResult` (returns `message_id`, throws on `code !== 0`).
- **`LarkChatGateway`**: paginates across pages via `page_token` and returns all summaries (FakeClient
  pattern from `larkSourceGateway.test.ts`).
- **`LarkMessageSender`**: builds the correct path + body (JSON-stringified `content`), returns the
  `message_id`, and surfaces a non-zero `code` as a throw.
- **`LarkClient.post`**: retries once on an auth-error code after refreshing the token (extend
  `larkClient.test.ts`).
- **`SendLarkMessage`**: delegates to the sender and returns `{ messageId }` (fake sender).
- No live network in tests. A manual live check (`pnpm lark:chats`, `pnpm lark:send --text "…"`
  against the test group) is the acceptance step.

## Out of scope

Rich message types; wiring pipeline/approved content into `lark:send`; adding Lark as a §6 channel;
`RecordPublish`/idempotency; Telegram/other §10 bots. These are follow-ups on top of this foundation.
