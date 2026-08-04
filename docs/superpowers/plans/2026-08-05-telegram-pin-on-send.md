# Telegram pin-on-send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-send choice — a checkbox on the dashboard's 발송/재발송 dialog, `--pin` on `pnpm send:channels` — pins the Telegram message the bot just posted.

**Architecture:** The flag rides the path `resend` already takes (dialog → API body → `sendToOutlet` → `SendChannels` → `sender.send`). Only `TelegramBotSender` acts on it, and it catches its own pin failure and returns it as a warning, so a failed pin can never be mistaken for a failed send.

**Tech Stack:** TypeScript, vitest, React + Testing Library for `web/`. No new dependencies — the Bot API call goes through the sender's existing `post()` helper.

**Spec:** `docs/superpowers/specs/2026-08-05-telegram-pin-on-send-design.md`

## How this plan is written

Tests are given as **code — write them verbatim**. Implementation steps are given as **invariants plus the files to read**, not as code to paste: this codebase's send path carries reasoning in comments that a pasted snippet would talk past. Read the named lines before writing anything.

## Global Constraints

- **A pin failure must never throw out of `send()`.** `SendChannels`' `catch` around `sender.send(...)` counts a throw as `failed` and writes **no ledger row**, so a thrown pin error leaves a live post that the next run re-sends. This is the one rule the whole change is built around.
- Nothing about an unpinned send changes — no extra API call, no new field on the wire, identical ledger rows.
- Never `unpinChatMessage` / `unpinAllChatMessages`. Existing pins are other people's.
- `disable_notification: true` on every pin.
- Code, comments, commit messages, CHANGELOG in **English**. Anything an operator reads on the dashboard in **Korean**.
- Exact warning text, defined once in `TelegramBotSender` and asserted by tests in three files — keep them in sync:
  `글은 올라갔지만 고정하지 못했습니다 (<API error>) — 봇을 이 방의 관리자로 올리고, 그룹은 '메시지 고정', 채널은 '메시지 수정' 권한을 주세요`
- Run `pnpm test` (root) and `pnpm test` (root vitest also runs `web/tests/**` — there is no separate web package) (web) before each commit. Never send to a live room to test anything.

## File map

| File | Change |
|---|---|
| `src/ports/ChannelSender.ts` | `SendRequest.pin?`, `SendResult.warning?` |
| `src/adapters/send/TelegramBotSender.ts` | pin the text-bearing message; catch its own failure |
| `src/app/SendChannels.ts` | `SendChannelsInput.pin?`, `SendChannelsResult.warnings` |
| `src/cli/sendToOutlet.ts` | trailing options object; warning → `error` with `sent > 0` |
| `src/adapters/web/apiHandlers.ts` | read `pin` from the body; forward as options |
| `src/cli/send-channels.ts` | `--pin`; print warnings |
| `web/src/components/ConfirmDialog.tsx` | optional toggle, reported to `onConfirm` |
| `web/src/components/OutletCard.tsx` | declare the toggle for Telegram auto rooms only |
| `web/src/api.ts` | `sendOutlet` takes `{ resend, pin }` |
| `.env.example`, `docs/ko/setup/channels.md`, `docs/ko/capabilities.md`, `CHANGELOG.md` | the admin right, the flag |

---

### Task 1: The sender pins the text-bearing message

**Files:**
- Modify: `src/ports/ChannelSender.ts`
- Modify: `src/adapters/send/TelegramBotSender.ts`
- Test: `tests/adapters/send/telegramBotSender.test.ts`

**Interfaces:**
- Produces:
  - `SendRequest.pin?: boolean` — "Pin the posted message in the room. Only Telegram acts on it."
  - `SendResult.warning?: string` — "Something after the post went wrong; the post itself is live. Never a reason to treat the send as failed."

**Read first:** `src/adapters/send/TelegramBotSender.ts:34-64` (how `firstId`, `asCaption` and `textSegments` already interact), and the spec's "Which message gets pinned" table.

- [ ] **Step 1: Write the failing tests**

Append to `tests/adapters/send/telegramBotSender.test.ts`:

```ts
describe("TelegramBotSender pins the message that carries the text", () => {
  const req = (o: Partial<Parameters<TelegramBotSender["send"]>[0]>) => ({
    itemId: "x:1", type: "announcement" as const, channel: "telegram" as const,
    segments: ["A"], chatId: "-100999", pin: true, ...o,
  });
  const pinCalls = (calls: { url: string; body: unknown }[]) =>
    calls.filter((c) => c.url.includes("/pinChatMessage"));

  it("pins the only message of a text-only send, silently", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 11 } } },
      { ok: true, status: 200, body: { result: true } },
    ]);
    const res = await new TelegramBotSender("TOK", fn).send(req({}));
    expect(pinCalls(calls)).toHaveLength(1);
    expect(pinCalls(calls)[0].body).toEqual({ chat_id: "-100999", message_id: 11, disable_notification: true });
    expect(res.warning).toBeUndefined();
  });

  it("pins the FIRST segment only, when the text goes out in two", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 11 } } },
      { ok: true, status: 200, body: { result: { message_id: 12 } } },
      { ok: true, status: 200, body: { result: true } },
    ]);
    await new TelegramBotSender("TOK", fn).send(req({ segments: ["A", "B"] }));
    expect(pinCalls(calls)).toHaveLength(1);
    expect(pinCalls(calls)[0].body).toMatchObject({ message_id: 11 });
  });

  it("pins the photo when the whole text went out as its caption", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 21 } } },
      { ok: true, status: 200, body: { result: true } },
    ]);
    await new TelegramBotSender("TOK", fn).send(req({ photos: ["https://img/1.png"] }));
    expect(calls[0].url).toContain("/sendPhoto");
    expect(pinCalls(calls)).toHaveLength(1);
    expect(pinCalls(calls)[0].body).toMatchObject({ message_id: 21 });
  });

  /**
   * The album is what `firstId` — and so the row's t.me link — points at, and it is deliberately
   * NOT what gets pinned: a pinned album reads as "Photo" in the room's pinned bar.
   */
  it("pins the text reply, not the album, on a media-group send", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: [{ message_id: 31 }, { message_id: 32 }] } },
      { ok: true, status: 200, body: { result: { message_id: 33 } } },
      { ok: true, status: 200, body: { result: true } },
    ]);
    const res = await new TelegramBotSender("TOK", fn).send(req({ photos: ["https://img/1.png", "https://img/2.png"] }));
    expect(calls[0].url).toContain("/sendMediaGroup");
    expect(pinCalls(calls)[0].body).toMatchObject({ message_id: 33 });
    expect(res.url).toBe("https://t.me/c/999/31"); // the link still points at the album
  });

  it("does not call pinChatMessage at all when the send did not ask for it", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { result: { message_id: 11 } } }]);
    await new TelegramBotSender("TOK", fn).send(req({ pin: false }));
    expect(pinCalls(calls)).toHaveLength(0);
  });

  /**
   * The post is already in the room. Throwing here would make `SendChannels` count the item as
   * failed and skip the ledger write, and the next run would post it a second time.
   */
  it("keeps a failed pin out of the send: resolves, warns, reports the post", async () => {
    const { fn } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 11 } } },
      { ok: false, status: 400, body: { description: "not enough rights to pin a message" } },
    ]);
    const res = await new TelegramBotSender("TOK", fn).send(req({}));
    expect(res.postId).toBe("11");
    expect(res.warning).toContain("고정하지 못했습니다");
    expect(res.warning).toContain("관리자");
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm vitest run tests/adapters/send/telegramBotSender.test.ts`
Expected: FAIL — no `pinChatMessage` call is made.

- [ ] **Step 3: Implement**

Invariants for `TelegramBotSender.send`:

- Track the id of the message carrying the text, separately from `firstId`: the `sendPhoto` id when `asCaption` was used, otherwise the id of the **first** `sendMessage` in the loop. Fall back to `firstId` if there is no text-bearing message at all.
- After every existing post has been made, and only when `req.pin` is true and a target id exists, `POST pinChatMessage` with `{ chat_id, message_id, disable_notification: true }`.
- Wrap that one call in `try/catch`. On failure set `warning` on the returned result using the Global Constraints text with the caught `message` interpolated. Nothing else about the result changes, and nothing rethrows.
- `firstId` and the `t.me` url keep their current meaning — do not repoint them.
- Write a short comment above the pin block saying why it cannot throw (name `SendChannels`' catch).

- [ ] **Step 4: Run the tests and the whole suite**

Run: `pnpm vitest run tests/adapters/send/` then `pnpm test`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/ports/ChannelSender.ts src/adapters/send/TelegramBotSender.ts tests/adapters/send/telegramBotSender.test.ts
git commit -m "feat(telegram): pin the text-bearing message when a send asks for it"
```

---

### Task 2: `SendChannels` carries the flag down and the warning back

**Files:**
- Modify: `src/app/SendChannels.ts`
- Test: `tests/app/sendChannels.test.ts`

**Interfaces:**
- Consumes: `SendRequest.pin`, `SendResult.warning` (Task 1)
- Produces:
  - `SendChannelsInput.pin?: boolean`
  - `SendChannelsResult.warnings: { key: string; error: string }[]` — same shape as `failures`, and **always present** (empty array when there are none), so callers need no optional handling.

**Read first:** `src/app/SendChannels.ts:38-67` (why `unconfigured` and `quotaBlocked` are deliberately not `failed` — `warnings` joins that family), and `:234-263` (the send call, the ledger write, the catch).

- [ ] **Step 1: Write the failing tests**

Append to `tests/app/sendChannels.test.ts`:

```ts
describe("SendChannels — pinning", () => {
  it("passes the run's pin flag to the sender", async () => {
    const seen: boolean[] = [];
    const sender: ChannelSender = {
      name: "telegram",
      send: async (req) => { seen.push(req.pin === true); return { postId: "p", url: "u" }; },
    };
    await new SendChannels(
      fakeStore([rendering({})]), { telegram: sender, x: undefined },
      fakeLedger().ledger, fakeTranslations(), undefined, undefined, undefined, 280,
      outletsForChannel, { "tg-community": "-100111", "tg-dev": "-100222" }, fakeOverrides(),
    ).run({ targets: ["telegram"], pin: true, outletIds: ["tg-community"] });
    expect(seen).toEqual([true]);
  });

  it("leaves pin absent when the run did not ask for it", async () => {
    const seen: unknown[] = [];
    const sender: ChannelSender = {
      name: "telegram",
      send: async (req) => { seen.push(req.pin); return { postId: "p", url: "u" }; },
    };
    await new SendChannels(
      fakeStore([rendering({})]), { telegram: sender, x: undefined },
      fakeLedger().ledger, fakeTranslations(), undefined, undefined, undefined, 280,
      outletsForChannel, { "tg-community": "-100111", "tg-dev": "-100222" }, fakeOverrides(),
    ).run({ targets: ["telegram"], outletIds: ["tg-community"] });
    expect(seen).toEqual([undefined]);
  });

  /**
   * THE regression test of this change. A post that reached the room but could not be pinned is a
   * `sent` with a ledger row — anything else and the next run posts it again.
   */
  it("counts a send whose pin failed as sent, writes its ledger row, and reports the warning", async () => {
    const { ledger, added } = fakeLedger();
    const sender: ChannelSender = {
      name: "telegram",
      send: async () => ({ postId: "p", url: "u", warning: "글은 올라갔지만 고정하지 못했습니다 (not enough rights)" }),
    };
    const result: SendChannelsResult = await new SendChannels(
      fakeStore([rendering({})]), { telegram: sender, x: undefined },
      ledger, fakeTranslations(), undefined, undefined, undefined, 280,
      outletsForChannel, { "tg-community": "-100111", "tg-dev": "-100222" }, fakeOverrides(),
    ).run({ targets: ["telegram"], pin: true, outletIds: ["tg-community"] });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ outletId: "tg-community", status: "sent" });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].error).toContain("고정하지 못했습니다");
  });

  it("reports no warnings for an ordinary send", async () => {
    const result = await new SendChannels(
      fakeStore([rendering({})]), { telegram: okSender("telegram"), x: undefined },
      fakeLedger().ledger, fakeTranslations(), undefined, undefined, undefined, 280,
      outletsForChannel, { "tg-community": "-100111", "tg-dev": "-100222" }, fakeOverrides(),
    ).run({ targets: ["telegram"], outletIds: ["tg-community"] });
    expect(result.warnings).toEqual([]);
  });
});
```

If the fixtures in this file take different arguments than the calls above (constructor arity, `rendering()` defaults), **fix the test calls to match the file** — do not change the fixtures.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm vitest run tests/app/sendChannels.test.ts`
Expected: FAIL — `pin` is not a known input, `warnings` is not on the result.

- [ ] **Step 3: Implement**

Invariants:

- `run()` forwards `input.pin` to every `sender.send({...})` call, unchanged and untranslated. Do not gate it on the channel — the sender that cannot pin ignores it.
- Collect `res.warning` into `warnings` **after** the ledger write, keyed by the same `key` the failure path uses, and `console.warn` it in the same `[send] …` shape as the neighbouring post-send warnings.
- A warning never touches `sent`, `failed`, `skipped`, or `failures`.
- Document `warnings` on `SendChannelsResult` in the vocabulary its neighbours use: the post is live and the run is not broken.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/app/sendChannels.test.ts` then `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/SendChannels.ts tests/app/sendChannels.test.ts
git commit -m "feat(send): carry the pin flag to the sender and its warning back"
```

---

### Task 3: The dashboard's send route takes `pin`

**Files:**
- Modify: `src/cli/sendToOutlet.ts`
- Modify: `src/adapters/web/apiHandlers.ts`
- Test: `tests/cli/sendToOutlet.test.ts`, `tests/adapters/web/apiHandlers.test.ts`

**Interfaces:**
- Consumes: `SendChannelsInput.pin`, `SendChannelsResult.warnings` (Task 2)
- Produces:
  - `export interface SendOptions { resend?: boolean; pin?: boolean }` in `src/cli/sendToOutlet.ts`
  - `makeSendToOutlet(deps)` returns `(itemId: string, type: string, outletId: string, opts?: SendOptions) => Promise<{ sent: number; failed: number; error?: string }>`
  - `ApiDeps.sendToOutlet` takes the same four parameters.

**Read first:** `src/cli/sendToOutlet.ts:409-506` (the returned function, and every `pending`/restore path a new parameter must not disturb), `src/adapters/web/apiHandlers.ts:502-530` (the route, and why 400 is reserved for `sent === 0`).

- [ ] **Step 1: Write the failing tests**

In `tests/cli/sendToOutlet.test.ts`, update the five existing `sendToOutlet(…, true)` calls to `sendToOutlet(…, { resend: true })` and append:

```ts
describe("makeSendToOutlet — pinning", () => {
  it("reports a pin warning as an error while still counting the send", async () => {
    const sends: { pin?: boolean }[] = [];
    const sendToOutlet = makeSendToOutlet(makeDeps({
      senders: () => ({
        telegram: {
          name: "telegram",
          send: async (req: { pin?: boolean }) => {
            sends.push({ pin: req.pin });
            return { postId: "p", url: "u", warning: "글은 올라갔지만 고정하지 못했습니다 (not enough rights)" };
          },
        },
        x: undefined,
      }),
    }));
    const result = await sendToOutlet("x:2", "announcement", "tg-community", { pin: true });
    expect(sends).toEqual([{ pin: true }]);
    expect(result.sent).toBe(1);
    expect(result.error).toContain("고정하지 못했습니다");
    expect(result.error).toContain("맨틀 한국 커뮤니티");
  });
});
```

Adapt the `makeDeps` call to this file's own helper — read it first; it already builds a fake store, ledger, translations and senders, and the only override this test needs is the sender.

In `tests/adapters/web/apiHandlers.test.ts`, widen the spy so the forwarded options are visible (`sendToOutlet: async (itemId, type, outletId, opts) => { spy.sends.push({ itemId, type, outletId, opts }); … }`), update the existing assertion at `:472` to include `opts`, and append:

```ts
it("POST send forwards the body's pin flag", async () => {
  const { spy, d } = spied();
  await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", { pin: true });
  expect(spy.sends).toEqual([{ itemId: "x:1", type: "announcement", outletId: "tg-dev", opts: { resend: false, pin: true } }]);
});

it("POST send without a body pins nothing", async () => {
  const { spy, d } = spied();
  await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", undefined);
  expect(spy.sends).toEqual([{ itemId: "x:1", type: "announcement", outletId: "tg-dev", opts: { resend: false, pin: false } }]);
});

/** A live post that could not be pinned is still a live post: 200, and the board repaints. */
it("POST send that posted but could not pin answers 200 with the reason", async () => {
  const { d } = spied({ send: () => ({ sent: 1, failed: 0, error: "맨틀 한국 데브방 (tg-dev): 글은 올라갔지만 고정하지 못했습니다" }) });
  const res = await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", { pin: true });
  expect(res.status ?? 200).toBe(200);
  expect((res.json as { error?: string }).error).toContain("고정하지 못했습니다");
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm vitest run tests/cli/sendToOutlet.test.ts tests/adapters/web/apiHandlers.test.ts`
Expected: FAIL — the fourth parameter is still a boolean, and `pin` is not read from the body.

- [ ] **Step 3: Implement**

Invariants:

- `sendToOutlet`'s fourth parameter becomes `opts: SendOptions = {}`; `resend` is read from it. Two adjacent positional booleans on a function that posts to live rooms is the defect this avoids — say so in one line above the signature.
- `pin` is forwarded to `SendChannels.run({ …, pin })` and nowhere else. It takes no part in the resend guard, the quota gate, or any `pending`/restore decision.
- When the run returns `sent > 0` **and** warnings, answer `{ sent, failed, error }` where `error` is each warning prefixed with `` `${outlet.label} (${outlet.id}): ` `` and joined with `" · "`, matching how `failures` are joined a few lines below.
- The `sent === 0` branch is unchanged: warnings never turn a zero-send into a different reason.
- `apiHandlers` reads `pin` exactly as it reads `resend` (`body?.pin === true`) and forwards `{ resend, pin }`. Update `ApiDeps.sendToOutlet`'s type and its doc comment; nothing about `sendsEnabled` or the 400 branch changes.
- Update the one production call site in `src/app/createDeps.ts` if the type change reaches it.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/cli/ tests/adapters/web/` then `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/sendToOutlet.ts src/adapters/web/apiHandlers.ts src/app/createDeps.ts tests/cli/sendToOutlet.test.ts tests/adapters/web/apiHandlers.test.ts
git commit -m "feat(web): accept a pin flag on the per-room send route"
```

---

### Task 4: `pnpm send:channels --pin`

**Files:**
- Modify: `src/cli/send-channels.ts`

**Interfaces:**
- Consumes: `SendChannelsInput.pin`, `SendChannelsResult.warnings` (Task 2)

**Read first:** `src/cli/send-channels.ts` in full (it is 86 lines), especially how `--outlets` validates before the senders are built and how the summary line is assembled.

There is no test for this file — it is a top-level script that runs on import, and the codebase tests the use case beneath it instead. Keep it thin enough that this stays true: read the flag, pass it, print.

- [ ] **Step 1: Implement**

Invariants:

- `const pin = process.argv.includes("--pin")` — the boolean-flag pattern used by `doctor.ts`, `clean.ts` and the rest.
- Passed to `.run({ …, pin })`. Nothing else in the run depends on it.
- `--pin` with no `telegram` in `targets` prints one `console.warn` saying nothing can be pinned on that channel, and the run proceeds.
- Every entry of `result.warnings` prints as its own line after the summary, so a batch that pinned nine of ten rooms names the tenth.
- Extend `OUTLETS_USAGE`'s neighbouring usage strings only if they already spell out flags; do not invent a new usage block.

- [ ] **Step 2: Prove the flag parses without sending**

Run: `pnpm send:channels --pin --outlets nope`
Expected: it exits on the unknown-outlet refusal (`Unknown outlet: nope`), which proves argument parsing runs and reaches validation without touching a sender. **Do not run it without `--outlets nope`** — that would post to live rooms.

- [ ] **Step 3: Typecheck and commit**

Run: `pnpm test` (the suite typechecks the tree it imports)

```bash
git add src/cli/send-channels.ts
git commit -m "feat(cli): add --pin to send:channels"
```

---

### Task 5: The confirm dialog can carry a toggle

**Files:**
- Modify: `web/src/components/ConfirmDialog.tsx`
- Test: `web/tests/ConfirmDialog.test.tsx` (create)

**Interfaces:**
- Produces:
  - `ConfirmRequest.toggle?: { label: string; hint?: string }`
  - `ConfirmRequest.onConfirm: (opts: { toggled: boolean }) => void` — existing zero-argument callers keep compiling unchanged.

**Read first:** `web/src/components/ConfirmDialog.tsx` in full, and `web/tests/OutletCard.test.tsx:60-95` for how this project mounts a component under test.

- [ ] **Step 1: Write the failing test**

Create `web/tests/ConfirmDialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog, type ConfirmRequest } from "../src/components/ConfirmDialog";

const base = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  title: "보냅니다", lines: ["되돌릴 수 없습니다."], confirmLabel: "발송", onConfirm: () => {}, ...over,
});

describe("ConfirmDialog — the optional toggle", () => {
  it("renders no checkbox when the request declares no toggle", () => {
    render(<ConfirmDialog request={base()} onCancel={() => {}} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("opens unchecked and reports false when confirmed untouched", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog request={base({ toggle: { label: "핀으로 고정하기" }, onConfirm })} onCancel={() => {}} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "발송" }));
    expect(onConfirm).toHaveBeenCalledWith({ toggled: false });
  });

  it("reports true when the operator ticks it", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog request={base({ toggle: { label: "핀으로 고정하기" }, onConfirm })} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "발송" }));
    expect(onConfirm).toHaveBeenCalledWith({ toggled: true });
  });

  /** A tick left over from the previous dialog is a pin nobody decided on. */
  it("opens unchecked again for the next request", () => {
    const { rerender } = render(<ConfirmDialog request={base({ toggle: { label: "핀으로 고정하기" } })} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox"));
    rerender(<ConfirmDialog request={null} onCancel={() => {}} />);
    rerender(<ConfirmDialog request={base({ title: "다시 보냅니다", toggle: { label: "핀으로 고정하기" } })} onCancel={() => {}} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run web/tests/ConfirmDialog.test.tsx`
Expected: FAIL — `toggle` is not part of `ConfirmRequest`.

- [ ] **Step 3: Implement**

Invariants:

- The checkbox sits between the consequence lines and the copy preview, is labelled by `toggle.label`, and shows `toggle.hint` as secondary text when present.
- Its state resets whenever `request` changes identity — the existing `useEffect` on `request` is where that belongs. The reset must survive the dialog being reopened with a different request object.
- The confirm button calls `onConfirm({ toggled })`; cancel and Esc still call `onCancel` and nothing else.
- Match the file's existing Tailwind vocabulary (`text-[13px]`, `text-muted`, `border-line`); do not introduce a new control style.

- [ ] **Step 4: Run the web tests**

Run: `pnpm test` (root vitest also runs `web/tests/**` — there is no separate web package)
Expected: PASS, including the existing dialog-free suites.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ConfirmDialog.tsx web/tests/ConfirmDialog.test.tsx
git commit -m "feat(web): let a confirm dialog carry an opt-in toggle"
```

---

### Task 6: The checkbox appears for Telegram rooms only

**Files:**
- Modify: `web/src/components/OutletCard.tsx`
- Modify: `web/src/api.ts`
- Test: `web/tests/OutletCard.test.tsx`

**Interfaces:**
- Consumes: `ConfirmRequest.toggle`, `onConfirm({ toggled })` (Task 5)
- Produces: `api.sendOutlet(itemId, type, outletId, opts?: { resend?: boolean; pin?: boolean })` — body `{ resend, pin }`.

**Read first:** `web/src/components/OutletCard.tsx:720-805` (`post`, `askSend`, `askResend`), `web/src/api.ts:163-169`, and `web/tests/OutletCard.test.tsx:60-95` (the `mount` helper that collects `ConfirmRequest`s).

- [ ] **Step 1: Write the failing tests**

Append to `web/tests/OutletCard.test.tsx`:

```tsx
describe("OutletCard — 핀 고정 is offered where it exists", () => {
  it("offers the pin toggle on a telegram room's 발송", () => {
    const { confirms } = mount(group({ channel: "telegram", rows: [row({ deliveryStatus: "pending" })] }));
    fireEvent.click(screen.getByRole("button", { name: "발송" }));
    expect(confirms[0].toggle?.label).toContain("고정");
  });

  it("offers it on 재발송 too", () => {
    const { confirms } = mount(group({ channel: "telegram", rows: [row({ deliveryStatus: "sent", at: "2026-07-30T01:00:00.000Z" })] }));
    fireEvent.click(screen.getByRole("button", { name: "재발송" }));
    expect(confirms[0].toggle?.label).toContain("고정");
  });

  /** X posts are published through Typefully; there is nothing to pin. */
  it("does not offer it on an X room", () => {
    const { confirms } = mount(group({ channel: "x", rows: [row({ deliveryStatus: "pending" })] }));
    fireEvent.click(screen.getByRole("button", { name: "발송" }));
    expect(confirms[0].toggle).toBeUndefined();
  });

  it("sends the toggle's answer to the API", async () => {
    const sent: unknown[] = [];
    const { confirms } = mount(
      group({ channel: "telegram", rows: [row({ deliveryStatus: "pending" })] }),
      { sendOutlet: async (...args: unknown[]) => { sent.push(args); return { sent: 1, failed: 0, board: emptyBoard() }; } },
    );
    fireEvent.click(screen.getByRole("button", { name: "발송" }));
    confirms[0].onConfirm({ toggled: true });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0] as unknown[])[3]).toEqual({ resend: false, pin: true });
  });
});
```

The last test needs the card's `api` to be stubbable. Read how the existing suite handles the API — if `mount` does not already accept a stub, add the smallest seam that lets it (a second `mount` argument merged over the default api object), and keep every existing call site working. `emptyBoard()` / `group()` / `row()` are this file's own helpers; reuse them rather than writing new fixtures, and match their real signatures.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run web/tests/OutletCard.test.tsx`
Expected: FAIL — no toggle is declared.

- [ ] **Step 3: Implement**

Invariants:

- `post(resend, pin)` passes `{ resend, pin }` to `api.sendOutlet`; `api.sendOutlet`'s fourth parameter becomes that options object and the body carries both keys.
- `askSend` and `askResend` declare `toggle` **only** when this row is an `auto` room on the `telegram` channel — read the channel from the group the card renders, and the delivery from the row.
- Label: `핀으로 고정하기`. Hint: one line saying the bot must be the room's admin, since that is the failure an operator will otherwise only meet after posting.
- `onConfirm` becomes `({ toggled }) => void post(<resend>, toggled)`. The X path keeps passing nothing extra.
- Nothing else about the row's locks, the quota refetch (`group.channel === "x"`), or the error handling changes.

- [ ] **Step 4: Run the web suite**

Run: `pnpm test` (root vitest also runs `web/tests/**` — there is no separate web package)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/OutletCard.tsx web/src/api.ts web/tests/OutletCard.test.tsx
git commit -m "feat(web): offer 핀으로 고정하기 on a Telegram room's send"
```

---

### Task 7: Say what the bot needs, and that the flag exists

**Files:**
- Modify: `.env.example` (the `TELEGRAM_BOT_TOKEN` block)
- Modify: `docs/ko/setup/channels.md` (§T-2)
- Modify: `docs/ko/capabilities.md` (the **J. 채널 발송** row, and §8's flag list)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

**Read first:** `docs/ko/setup/channels.md:26-36` (T-2 already distinguishes group membership from channel admin rights — the pin note belongs there, as a third case), `docs/ko/capabilities.md:186` and the §8 flags paragraph around `:289`, and `tests/docs/koDocs.test.ts` (fenced commands must exist as `package.json` scripts).

- [ ] **Step 1: Write the docs**

Invariants:

- T-2 gains: pinning needs the bot to be an **administrator** of the room — 그룹은 **메시지 고정**, 채널은 **메시지 수정** — and without it the send still goes out and the dashboard reports that the pin failed. State it as the condition for the checkbox to work, not as a general recommendation.
- `.env.example`'s `TELEGRAM_BOT_TOKEN` comment gains one sentence pointing at that, in the same clipped style as its neighbours.
- `capabilities.md`: `[--pin]` in J's command cell, and one sentence in §8 saying the flag pins the message and defaults off. Keep the existing sentence rhythm.
- CHANGELOG under `### Added` in `[Unreleased]` (create the heading only if absent), English, naming both entry points and the admin right.

- [ ] **Step 2: Run the docs test**

Run: `pnpm vitest run tests/docs/koDocs.test.ts`
Expected: PASS — no broken links, no command that does not exist.

- [ ] **Step 3: Full suite, both projects**

Run: `pnpm test` and `pnpm test` (root vitest also runs `web/tests/**` — there is no separate web package)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/ko/setup/channels.md docs/ko/capabilities.md CHANGELOG.md
git commit -m "docs: state the admin right pinning needs, and the --pin flag"
```

---

## Verification before the PR

- [ ] `pnpm test` and `pnpm test` (root vitest also runs `web/tests/**` — there is no separate web package) both green, output pasted into the summary.
- [ ] `git log --oneline` shows one commit per task.
- [ ] Grep the diff for `unpin` — there must be no hit.
- [ ] Confirm by reading `SendChannels`' send block that no new `throw` sits between the sender call and the ledger write.
- [ ] The dashboard is not driven in a browser here: proving the checkbox end-to-end means posting to a live room. Leave that to Kyle, and say so in the PR body along with what the tests do cover.
