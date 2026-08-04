# Pinning a Telegram send

A per-send choice, made by the person clicking [발송], to pin the message the bot just posted.
Nothing about an unpinned send changes.

Written 2026-08-05, from the Bot API's own wording on `pinChatMessage` and from what the existing
send path already does with a failure.

## The goal, in one sentence

An operator who is posting a 공지 can have it pinned in the room without opening Telegram, and an
operator who is posting anything else cannot do it by accident.

## What decides the pin

**The click, and nothing else.** The checkbox is off every time the dialog opens, is stored
nowhere, and applies to exactly the one send it was checked for. `--pin` on `pnpm send:channels` is
the same choice for a batch run, and defaults off in the same way.

Rejected: a saved per-room setting, and a `pinOnSend` constant on the outlet. Both make a later
batch run pin something nobody was looking at when it went out. Pinning is a decision about *this*
message being worth the top of the room, which is a judgement someone makes with the copy in front
of them — the same reason the send itself is a click rather than a schedule.

## Which message gets pinned

**The first message that carries the text.**

One send can produce several messages. `TelegramBotSender` already distinguishes the cases:

| Send shape | Pinned |
|---|---|
| single photo + short single segment (text goes as the caption) | that photo message |
| media group + text as a separate reply | the **text** message, not the album |
| text only, one or more segments | the first segment |

This is deliberately **not** always `firstId` — the id the ledger's `t.me` link is built from. A
pinned album shows as "Photo" in the room's pinned bar, which tells a reader nothing; the pinned
bar is a one-line summary and the text is what makes it useful. The link and the pin can therefore
point at two different messages of the same send, which is correct: they answer different
questions ("where is this post" vs "what is pinned").

Only one message per send is pinned. Pinning every segment of a two-part 공지 fills the room's
pinned list with the tail of one announcement.

## What is never touched

**Existing pins.** No `unpinChatMessage`, no `unpinAllChatMessages`, ever. The room's pinned list is
shared with people who are not this pipeline — a community manager pins an event notice by hand —
and a bot that silently unpins on every send takes those down. Telegram shows the most recent pin
at the top of the room, so a new pin already reads as the current one without removing anything.

## The pin is silent

`disable_notification: true`. The message itself has just notified the room; a second "pinned a
message" alert for the same content is noise. (In channels Telegram forces this anyway.)

## A pin failure is not a send failure

The post is irreversible; the pin is a three-second manual fix in the Telegram app. So the send
stands and the failure is reported.

**The pin call must never throw out of `send()`.** This is the load-bearing rule of the whole
change. `SendChannels` (`src/app/SendChannels.ts`, the `catch` around the sender call) counts a
throwing send as `failed` and writes **no ledger row** — so a pin error escaping `send()` would
leave a live post that the ledger says was never delivered, and the next run would post it again.
The same reasoning is already written down two lines below that call, where a ledger-write failure
after a successful send is deliberately not counted as a failure.

So `TelegramBotSender` catches the pin error itself and returns it as a warning on the result. The
send is `sent`, the ledger row is written, and the warning travels separately:

- CLI: one `[send] <key>: …` line, alongside the run's summary.
- Dashboard: the row settles to `발송됨` and the error banner carries the reason. `sendToOutlet`
  puts the warning in `error` while `sent` stays above zero, which the API layer already answers
  `200` for — `400` is reserved for `sent === 0`.

The message names the fix, because the fix is not in this codebase: the bot must be an
administrator of the room, with **메시지 고정** in a group and **메시지 수정** in a channel (the Bot
API's `can_pin_messages` and `can_edit_messages`). It is Korean, like the quota refusals on the same
path — a dashboard operator has no terminal and is the person who can act on it.

Rejected: checking the bot's rights with `getChatMember` before posting and refusing the send when
it cannot pin. It trades an irreversible thing (the announcement going out on time) for a
recoverable one (a pin someone can add by hand), and it puts a Telegram round trip in front of every
pinned send.

## Where the flag travels

The route `resend` already takes, unchanged in shape:

```
ConfirmDialog checkbox
  → api.sendOutlet(itemId, type, outletId, { resend, pin })
  → POST /api/outlets/:id/:type/:outletId/send   { resend, pin }
  → sendToOutlet(itemId, type, outletId, { resend, pin })
  → SendChannels.run({ ..., pin })
  → sender.send({ ..., pin })
  → TelegramBotSender: pinChatMessage
```

`SendRequest.pin` is on the shared port, so every sender receives it and only the Telegram one acts
on it. That is cheaper than a Telegram-only method on the port, and the checkbox never appears for a
room whose channel cannot pin.

`sendToOutlet`'s trailing `resend?: boolean` becomes an options object rather than growing a second
positional boolean — two adjacent booleans at a call site are a defect waiting for someone to swap
them, on a function whose whole job is to post to a live room.

`--pin` passed to a run with no Telegram target warns once and proceeds; nothing else in the run
depends on it.

## The checkbox

In the existing `ConfirmDialog`, below the consequence lines and above the copy preview, on both the
발송 and the 재발송 dialogs. It renders **only** for an `auto` room on the `telegram` channel.

`ConfirmRequest` gains an optional toggle description, and `onConfirm` receives whether it was
checked. Callers that declare no toggle are unaffected.

Off on every open. A checkbox that remembers its last state is a checkbox that eventually pins
something because of a decision made twenty minutes ago about a different post.

## Tests

The ones that would have caught a real defect:

- **The regression that matters:** a pin that fails leaves the item counted as `sent` and its ledger
  row written. This is the double-post guard; it belongs in `SendChannels`' tests, not only in the
  sender's.
- `pinChatMessage` is called with the id of the text-bearing message in each of the three send
  shapes above, and with `disable_notification: true`.
- No `pin` in the request means no `pinChatMessage` call at all.
- The warning reaches the API reply with `sent > 0` and HTTP 200.
- `pin` in the request body reaches `sendToOutlet`; absent means false.
- The checkbox renders for a Telegram `auto` row, not for an X row, and opens unchecked.

## Documentation

`.env.example` (the `TELEGRAM_BOT_TOKEN` block) and `docs/ko/setup/channels.md` state the admin
right the pin needs, since an install without it gets a warning at send time and no other clue.
CHANGELOG in English, as ever.
