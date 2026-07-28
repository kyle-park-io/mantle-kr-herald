# Outlet Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the review dashboard a per-room delivery board — one card per `(type, channel)` holding the text and the rooms that receive it, with auto send, manual "전달함" tracking, and per-room text forking.

**Architecture:** Introduce `Outlet` (a delivery room) as a domain concept alongside the existing `type` and `channel` axes. Re-key the send ledger from `(itemId, type, channel)` to `(itemId, type, outlet)` so two rooms on one channel stop conflating. Text stays shared per `(type, channel)` and forks to a per-outlet override only when the reviewer edits one room — the same rule `FormatVariants` already applies one level up at the channel layer.

**Tech Stack:** TypeScript (ESM, hexagonal: domain / ports / adapters / app / cli), zod-only runtime dependency, native `fetch`, vitest. Frontend is React + Vite + Tailwind v4 in `web/` (build-time devDependencies only).

## Global Constraints

- **Runtime dependencies stay `zod` only.** No new packages in `dependencies`. Frontend packages are devDependencies.
- **The frontend cannot import the domain** — `web/tsconfig.json` includes only `web/src` and Vite's root is `web/`. Vocabulary is mirrored in `web/src/types.ts` and guarded by `tests/web/typeMirror.test.ts`; extend that test when adding a mirrored constant.
- **Outlet ids are exactly:** `x-post`, `x-article`, `tg-community`, `tg-dev`, `tg-kol`, `tg-blockchain`, `kakao-kol`, `kakao-blockchain`, `pr-mail`.
- **`sent` is irreversible, `delivered` is reversible.** A bot/API success is an observation; a human tick is a claim.
- **A failed send is never ledgered** (a retry must re-send). **A ledger-write failure after a successful send still counts as sent, with a warning** — the inverse re-sends live content. Inherited from `SendChannels`, do not re-decide.
- **`.env.example`:** new keys go in the existing Telegram section beside `TELEGRAM_BOT_TOKEN`, values left empty, with a comment naming the room and how to get the id.
- **Every test must be able to fail.** Verify by mutation before accepting a task.
- Existing behaviour with no outlet configuration must be byte-identical to today.

**Phasing:** Tasks 1–6 are a shippable backend slice — they fix the room-conflation bug and work through the CLI with no UI change. Tasks 7–9 add the dashboard board. Stopping after Task 6 leaves the repo in a working, releasable state.

---

### Task 1: Outlet domain model

**Files:**
- Create: `src/domain/outlet/models.ts`
- Test: `tests/domain/outlet/models.test.ts`

**Interfaces:**
- Consumes: `Channel` from `src/domain/formatting/models`, `ConversionType` from `src/domain/conversion/models`.
- Produces: `Outlet` interface; `ALL_OUTLETS: Outlet[]`; `outletById(id: string): Outlet | undefined`; `outletsForChannel(channel: Channel): Outlet[]`; `PRIMARY_OUTLET_BY_CHANNEL: Record<Channel, string>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/outlet/models.test.ts
import { describe, expect, it } from "vitest";
import { ALL_OUTLETS, PRIMARY_OUTLET_BY_CHANNEL, outletById, outletsForChannel } from "../../../src/domain/outlet/models";
import { ALL_CHANNELS } from "../../../src/domain/formatting/models";
import { ALL_TYPES } from "../../../src/domain/conversion/models";

describe("outlet model", () => {
  it("defines the nine rooms with unique ids", () => {
    expect(ALL_OUTLETS).toHaveLength(9);
    expect(new Set(ALL_OUTLETS.map((o) => o.id)).size).toBe(9);
  });

  it("looks an outlet up by id and returns undefined for an unknown one", () => {
    expect(outletById("tg-dev")?.label).toBe("맨틀 한국 데브방");
    expect(outletById("nope")).toBeUndefined();
  });

  it("groups outlets by channel — telegram carries four rooms", () => {
    expect(outletsForChannel("telegram").map((o) => o.id)).toEqual(["tg-community", "tg-dev", "tg-kol", "tg-blockchain"]);
    expect(outletsForChannel("kakao").map((o) => o.id)).toEqual(["kakao-kol", "kakao-blockchain"]);
  });

  it("names a primary outlet for every channel, and each one exists", () => {
    for (const channel of ALL_CHANNELS) {
      const id = PRIMARY_OUTLET_BY_CHANNEL[channel];
      expect(id, `primary outlet for ${channel}`).toBeTruthy();
      expect(outletById(id)?.channel, `primary of ${channel} must sit on ${channel}`).toBe(channel);
    }
  });

  it("only suggests types that exist, and only auto telegram rooms carry a chat id env", () => {
    for (const o of ALL_OUTLETS) {
      for (const t of o.suggestedTypes) expect(ALL_TYPES, `${o.id} suggests ${t}`).toContain(t);
      if (o.chatIdEnv) {
        expect(o.delivery, `${o.id} has a chat id but is not auto`).toBe("auto");
        expect(o.channel, `${o.id} has a chat id but is not telegram`).toBe("telegram");
      }
    }
  });

  it("gives the article outlet no suggested types — the translation goes direct", () => {
    expect(outletById("x-article")?.suggestedTypes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/domain/outlet/models.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/outlet/models'`

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/outlet/models.ts
import type { Channel } from "../formatting/models";
import type { ConversionType } from "../conversion/models";

/**
 * A delivery room. The third axis, distinct from the other two: `type` is what kind of copy this
 * is, `channel` is what format it takes, `outlet` is where it goes. Two outlets can share a
 * channel (맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are both auto Telegram), which is precisely
 * why the send ledger is keyed by outlet rather than channel.
 *
 * NOT to be confused with `Destination` in domain/formatting/emitters, which is the *spelling* of
 * a channel (`telegram_paste` vs `telegram_bot`), nor with `--target` in `drive:publish`.
 */
export interface Outlet {
  id: string;
  label: string;
  channel: Channel;
  /** `auto` = a bot/API posts it. `manual` = a human copies the `_paste` text and pastes it. */
  delivery: "auto" | "manual";
  /** Pre-checked rows on the board. Every type stays selectable — this is a default, not a limit. */
  suggestedTypes: ConversionType[];
  /** Name of the env var holding the chat id. Only auto Telegram rooms have one. */
  chatIdEnv?: string;
}

/**
 * A code constant, not configuration: rooms change rarely, and a constant is what lets the
 * invariant tests and the UI labels stay in sync — the same reasoning behind ALL_TYPES.
 * Only the Telegram chat ids live in `.env`.
 */
export const ALL_OUTLETS: Outlet[] = [
  { id: "x-post", label: "@0xMantleKR 포스트", channel: "x", delivery: "auto", suggestedTypes: ["x"] },
  { id: "x-article", label: "@0xMantleKR 아티클", channel: "x", delivery: "auto", suggestedTypes: [] },
  { id: "tg-community", label: "맨틀 한국 커뮤니티", channel: "telegram", delivery: "auto", suggestedTypes: ["announcement", "casual"], chatIdEnv: "TELEGRAM_CHAT_ID_COMMUNITY" },
  { id: "tg-dev", label: "맨틀 한국 데브방", channel: "telegram", delivery: "auto", suggestedTypes: ["announcement", "explainer"], chatIdEnv: "TELEGRAM_CHAT_ID_DEV" },
  { id: "tg-kol", label: "텔레그램 KOL방", channel: "telegram", delivery: "manual", suggestedTypes: ["kol", "announcement"] },
  { id: "tg-blockchain", label: "한국 블록체인 커뮤니티방", channel: "telegram", delivery: "manual", suggestedTypes: ["announcement"] },
  { id: "kakao-kol", label: "오픈카톡 KOL방", channel: "kakao", delivery: "manual", suggestedTypes: ["announcement"] },
  { id: "kakao-blockchain", label: "오픈카톡 블록체인 커뮤니티방", channel: "kakao", delivery: "manual", suggestedTypes: ["announcement"] },
  { id: "pr-mail", label: "PR 메일", channel: "pr_mail", delivery: "auto", suggestedTypes: ["pr"] },
];

/**
 * Where a legacy `(itemId, type, channel)` ledger row is attributed when re-keyed by outlet.
 * The two kakao rooms are interchangeable for this purpose, so `kakao-blockchain` is an
 * arbitrary but fixed choice — recorded here so a later reader does not look for meaning in it.
 */
export const PRIMARY_OUTLET_BY_CHANNEL: Record<Channel, string> = {
  x: "x-post",
  telegram: "tg-community",
  kakao: "kakao-blockchain",
  pr_mail: "pr-mail",
};

export function outletById(id: string): Outlet | undefined {
  return ALL_OUTLETS.find((o) => o.id === id);
}

export function outletsForChannel(channel: Channel): Outlet[] {
  return ALL_OUTLETS.filter((o) => o.channel === channel);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/domain/outlet/models.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Mutation-check the invariants**

Temporarily change `PRIMARY_OUTLET_BY_CHANNEL.telegram` to `"kakao-kol"` and re-run — the "primary of telegram must sit on telegram" assertion must fail. Then add `chatIdEnv: "X"` to `tg-kol` and re-run — the "has a chat id but is not auto" assertion must fail. Revert both and confirm the file is byte-identical (`git diff --stat` shows nothing).

- [ ] **Step 6: Commit**

```bash
git add src/domain/outlet/models.ts tests/domain/outlet/models.test.ts
git commit -m "feat(outlet): add the Outlet domain model — nine delivery rooms"
```

---

### Task 2: Per-outlet Telegram chat ids

**Files:**
- Modify: `src/config.ts` (add below `loadTelegramConfig`)
- Modify: `.env.example` (Telegram section, beside `TELEGRAM_BOT_TOKEN`)
- Test: `tests/config/telegramOutlets.test.ts`

**Interfaces:**
- Consumes: `ALL_OUTLETS` from Task 1.
- Produces: `loadTelegramChatIds(): Record<string, string>` — outlet id → chat id, only for outlets that resolve one.

- [ ] **Step 1: Write the failing test**

```ts
// tests/config/telegramOutlets.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTelegramChatIds } from "../../src/config";

const ENV_KEYS = ["TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID_COMMUNITY", "TELEGRAM_CHAT_ID_DEV"];
function withEnv(values: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
}
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

describe("loadTelegramChatIds", () => {
  it("reads a chat id per outlet", () => {
    withEnv({ TELEGRAM_CHAT_ID_COMMUNITY: "-100111", TELEGRAM_CHAT_ID_DEV: "-100222" });
    expect(loadTelegramChatIds()).toEqual({ "tg-community": "-100111", "tg-dev": "-100222" });
  });

  it("falls back to legacy TELEGRAM_CHAT_ID for the primary room only, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withEnv({ TELEGRAM_CHAT_ID: "-100999" });
    expect(loadTelegramChatIds()).toEqual({ "tg-community": "-100999" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("TELEGRAM_CHAT_ID_COMMUNITY");
  });

  it("prefers the per-outlet variable over the legacy one and does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withEnv({ TELEGRAM_CHAT_ID: "-100999", TELEGRAM_CHAT_ID_COMMUNITY: "-100111" });
    expect(loadTelegramChatIds()).toEqual({ "tg-community": "-100111" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns an empty map when nothing is configured", () => {
    withEnv({});
    expect(loadTelegramChatIds()).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/config/telegramOutlets.test.ts`
Expected: FAIL — `loadTelegramChatIds is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/config.ts`:

```ts
/**
 * Chat id per auto Telegram outlet. Splitting the old single `TELEGRAM_CHAT_ID` would stop sends
 * dead on `git pull`, so the primary room (`tg-community`) still falls back to it, with a warning.
 * A room with no id resolved is simply absent from the map — callers skip it.
 */
export function loadTelegramChatIds(): Record<string, string> {
  const out: Record<string, string> = {};
  const legacy = process.env.TELEGRAM_CHAT_ID;
  for (const outlet of ALL_OUTLETS) {
    if (!outlet.chatIdEnv) continue;
    const own = process.env[outlet.chatIdEnv];
    if (own) {
      out[outlet.id] = own;
      continue;
    }
    if (legacy && outlet.id === PRIMARY_OUTLET_BY_CHANNEL.telegram) {
      out[outlet.id] = legacy;
      console.warn(
        `[config] TELEGRAM_CHAT_ID is deprecated — set ${outlet.chatIdEnv} instead. ` +
          `Using it for ${outlet.label} only; other rooms stay unconfigured.`,
      );
    }
  }
  return out;
}
```

Add to the imports at the top of `src/config.ts`:

```ts
import { ALL_OUTLETS, PRIMARY_OUTLET_BY_CHANNEL } from "./domain/outlet/models";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/config/telegramOutlets.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Update `.env.example`**

In the existing Telegram section, directly under `TELEGRAM_CHAT_ID=`, add:

```
# 방별 채팅 ID (§8 발송). 봇을 각 방에 초대한 뒤, 그 방에서 아무 메시지나 보내고
# https://api.telegram.org/bot<TOKEN>/getUpdates 의 result[].message.chat.id 를 복사하세요.
# 슈퍼그룹/채널은 -100 으로 시작합니다. 비워두면 그 방으로는 발송하지 않습니다.
# TELEGRAM_CHAT_ID(위)는 레거시입니다 — 비어 있으면 맨틀 한국 커뮤니티에만 폴백으로 쓰입니다.
TELEGRAM_CHAT_ID_COMMUNITY=
TELEGRAM_CHAT_ID_DEV=
```

- [ ] **Step 6: Verify the whole suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass — no existing test reads `loadTelegramChatIds`, and `loadTelegramConfig` is untouched.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts .env.example tests/config/telegramOutlets.test.ts
git commit -m "feat(config): per-outlet Telegram chat ids with a legacy fallback"
```

---

### Task 3: Delivery ledger model and store

**Files:**
- Create: `src/domain/delivery/models.ts`
- Create: `src/ports/DeliveryLedger.ts`
- Create: `src/adapters/store/JsonDeliveryLedger.ts`
- Modify: `src/paths.ts` (add `deliveries`)
- Test: `tests/adapters/store/JsonDeliveryLedger.test.ts`

**Interfaces:**
- Consumes: `ALL_OUTLETS`, `PRIMARY_OUTLET_BY_CHANNEL` from Task 1; `ChannelSentEntry` from `src/domain/send/channels`.
- Produces: `DeliveryEntry`; `deliveryKey(e): string`; `migrateLegacyEntry(e: ChannelSentEntry): DeliveryEntry`; `DeliveryLedger` port with `loadAll()`, `loadKeys()`, `add(entry)`, `remove(key)`; `JsonDeliveryLedger`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/adapters/store/JsonDeliveryLedger.test.ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { JsonDeliveryLedger } from "../../../src/adapters/store/JsonDeliveryLedger";
import { deliveryKey } from "../../../src/domain/delivery/models";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deliveries-"));
});

const sent = { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent" as const, at: "2026-07-29T00:00:00.000Z", by: "auto" as const };

describe("JsonDeliveryLedger", () => {
  it("round-trips an entry", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    expect(await l.loadAll()).toEqual([sent]);
    expect([...(await l.loadKeys())]).toEqual(["x:1:announcement:tg-community"]);
  });

  it("keeps two rooms on one channel apart — THE bug this re-keying exists to prevent", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    const keys = await l.loadKeys();
    expect(keys.has(deliveryKey({ itemId: "x:1", type: "announcement", outletId: "tg-community" }))).toBe(true);
    expect(keys.has(deliveryKey({ itemId: "x:1", type: "announcement", outletId: "tg-dev" }))).toBe(false);
  });

  it("upserts on the same key rather than appending", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    await l.add({ ...sent, url: "https://t.me/c/1/2" });
    const all = await l.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.url).toBe("https://t.me/c/1/2");
  });

  it("removes an entry by key (used to untick 전달함)", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add({ ...sent, status: "delivered", by: "manual" });
    await l.remove(deliveryKey(sent));
    expect(await l.loadAll()).toEqual([]);
  });

  it("migrates a legacy channel-keyed ledger to the channel's primary outlet", async () => {
    await writeFile(
      join(dir, "channels.json"),
      JSON.stringify([
        { itemId: "x:1", type: "announcement", channel: "telegram", senderName: "telegram-bot", sentAt: "2026-07-01T00:00:00.000Z", url: "u" },
        { itemId: "x:2", type: "x", channel: "x", senderName: "typefully", sentAt: "2026-07-02T00:00:00.000Z", postId: "p" },
      ]),
      "utf8",
    );
    const all = await new JsonDeliveryLedger(dir).loadAll();
    expect(all.map((e) => [e.itemId, e.outletId, e.status, e.by])).toEqual([
      ["x:1", "tg-community", "sent", "auto"],
      ["x:2", "x-post", "sent", "auto"],
    ]);
    expect(all[0]?.at).toBe("2026-07-01T00:00:00.000Z");
    expect(all[0]?.url).toBe("u");
  });

  it("persists a migrated legacy row on the first write, leaving channels.json untouched", async () => {
    const legacy = JSON.stringify([{ itemId: "x:9", type: "x", channel: "x", senderName: "s", sentAt: "2026-07-01T00:00:00.000Z" }]);
    await writeFile(join(dir, "channels.json"), legacy, "utf8");
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    expect((await l.loadAll()).map((e) => e.itemId).sort()).toEqual(["x:1", "x:9"]);
    expect(JSON.parse(await readFile(join(dir, "deliveries.json"), "utf8"))).toHaveLength(2);
    expect(await readFile(join(dir, "channels.json"), "utf8")).toBe(legacy); // migration is read-only
  });

  it("keeps a legacy sent item visible in loadKeys() after an unrelated add — or it gets re-sent live", async () => {
    await writeFile(join(dir, "channels.json"), JSON.stringify([{ itemId: "x:100", type: "announcement", channel: "telegram", senderName: "telegram-bot", sentAt: "2026-07-01T00:00:00.000Z" }]), "utf8");
    const l = new JsonDeliveryLedger(dir);
    const legacyKey = "x:100:announcement:tg-community";
    expect((await l.loadKeys()).has(legacyKey)).toBe(true);
    await l.add({ itemId: "x:200", type: "announcement", outletId: "tg-dev", status: "sent", at: "T", by: "auto" });
    expect((await l.loadKeys()).has(legacyKey)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/store/JsonDeliveryLedger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the domain model**

```ts
// src/domain/delivery/models.ts
import type { ConversionType } from "../conversion/models";
import type { ChannelSentEntry } from "../send/channels";
import { PRIMARY_OUTLET_BY_CHANNEL } from "../outlet/models";

/**
 * One piece of copy delivered to one room.
 *
 * `sent` is an observation — a bot or API call succeeded — and is never reversed.
 * `delivered` is a claim: a human ticked 전달함 after pasting it by hand, and can untick it.
 */
export interface DeliveryEntry {
  itemId: string;
  type: string;
  outletId: string;
  status: "sent" | "delivered";
  at: string; // ISO
  by: "auto" | "manual";
  postId?: string;
  url?: string;
  senderName?: string;
}

export function deliveryKey(e: Pick<DeliveryEntry, "itemId" | "type" | "outletId">): string {
  return `${e.itemId}:${e.type}:${e.outletId}`;
}

/**
 * Re-key a pre-outlet ledger row. The old key carried a channel, so the room is unknowable —
 * attribute it to that channel's primary outlet, mirroring how `publish/state.json` migrates its
 * legacy `{published:[…]}` shape on read.
 */
export function migrateLegacyEntry(e: ChannelSentEntry): DeliveryEntry {
  return {
    itemId: e.itemId,
    type: e.type,
    outletId: PRIMARY_OUTLET_BY_CHANNEL[e.channel] ?? e.channel,
    status: "sent",
    at: e.sentAt,
    by: "auto",
    postId: e.postId,
    url: e.url,
    senderName: e.senderName,
  };
}
```

- [ ] **Step 4: Write the port and adapter**

```ts
// src/ports/DeliveryLedger.ts
import type { DeliveryEntry } from "../domain/delivery/models";

export interface DeliveryLedger {
  loadAll(): Promise<DeliveryEntry[]>;
  loadKeys(): Promise<Set<string>>;
  add(entry: DeliveryEntry): Promise<void>;
  remove(key: string): Promise<void>;
}
```

```ts
// src/adapters/store/JsonDeliveryLedger.ts
import { join } from "node:path";
import type { ChannelSentEntry } from "../../domain/send/channels";
import type { DeliveryEntry } from "../../domain/delivery/models";
import { deliveryKey, migrateLegacyEntry } from "../../domain/delivery/models";
import type { DeliveryLedger } from "../../ports/DeliveryLedger";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonDeliveryLedger implements DeliveryLedger {
  private readonly path: string;
  private readonly legacyPath: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "deliveries.json");
    this.legacyPath = join(dir, "channels.json");
  }

  /**
   * Reads the outlet-keyed file, falling back to the pre-outlet `channels.json` when it is absent.
   * The migration is read-only: the legacy file is never rewritten or deleted, so a rollback loses
   * nothing.
   *
   * `add()`/`remove()` build their write base from `loadAll()`, NOT from a raw read — so the first
   * write persists the migrated rows. That is deliberate: reading past them would make an
   * already-sent item indistinguishable from never-sent the moment any unrelated row is written,
   * and `SendChannels` gates only on ledger membership, so it would re-post live content.
   */
  async loadAll(): Promise<DeliveryEntry[]> {
    const current = await readJsonFile<DeliveryEntry[] | null>(this.path, null);
    if (current) return current;
    const legacy = await readJsonFile<ChannelSentEntry[]>(this.legacyPath, []);
    return legacy.map(migrateLegacyEntry);
  }

  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.loadAll()).map(deliveryKey));
  }

  async add(entry: DeliveryEntry): Promise<void> {
    const byKey = new Map((await this.loadAll()).map((e) => [deliveryKey(e), e]));
    byKey.set(deliveryKey(entry), entry);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }

  async remove(key: string): Promise<void> {
    const kept = (await this.loadAll()).filter((e) => deliveryKey(e) !== key);
    await writeJsonFileAtomic(this.dir, this.path, kept);
  }
}
```

- [ ] **Step 5: No path change needed**

`src/paths.ts:34` already exports `publishDir: join(OUTPUT_DIR, "publish")`, and `JsonDeliveryLedger` takes a directory. Use `paths.publishDir` at call sites. Do **not** add a `deliveries` key — a second name for the same directory is exactly the kind of duplication that drifts.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test tests/adapters/store/JsonDeliveryLedger.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Mutation-check the migration**

Change `PRIMARY_OUTLET_BY_CHANNEL` lookup in `migrateLegacyEntry` to a hardcoded `"tg-community"` and re-run — the legacy-migration test must fail on the `x:2 → x-post` row. Revert.

- [ ] **Step 8: Commit**

```bash
git add src/domain/delivery src/ports/DeliveryLedger.ts src/adapters/store/JsonDeliveryLedger.ts tests/adapters/store/JsonDeliveryLedger.test.ts
git commit -m "feat(delivery): outlet-keyed delivery ledger with legacy migration"
```

---

### Task 4: Telegram sender takes a chat id per send

**Files:**
- Modify: `src/adapters/send/TelegramBotSender.ts`
- Test: `tests/adapters/send/TelegramBotSender.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SendRequest` gains an optional `chatId?: string`; when present the sender posts there, otherwise it uses its constructor chat id (today's behaviour, byte-identical).

- [ ] **Step 1: Read the sender and its tests first**

Run: `sed -n '1,60p' src/adapters/send/TelegramBotSender.ts` and `grep -n "chatId" src/adapters/send/TelegramBotSender.ts src/ports/ChannelSender.ts`. Note the exact field name the sender uses for the chat id in its API calls — the code below assumes `this.chatId`; adjust to what is actually there.

- [ ] **Step 2: Write the failing test**

Add to `tests/adapters/send/TelegramBotSender.test.ts`:

```ts
it("posts to the per-request chatId when one is given", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1, chat: { id: -100777 } } }) };
  }) as unknown as typeof fetch;

  const sender = new TelegramBotSender({ botToken: "T", chatId: "-100111" }, fakeFetch);
  await sender.send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["안녕"], chatId: "-100222" });

  expect((calls[0]?.body as { chat_id: string }).chat_id).toBe("-100222");
});

it("falls back to the configured chatId when the request omits one", async () => {
  const calls: { body: unknown }[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1, chat: { id: -100111 } } }) };
  }) as unknown as typeof fetch;

  const sender = new TelegramBotSender({ botToken: "T", chatId: "-100111" }, fakeFetch);
  await sender.send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["안녕"] });

  expect((calls[0]?.body as { chat_id: string }).chat_id).toBe("-100111");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/adapters/send/TelegramBotSender.test.ts`
Expected: FAIL — the first test posts to `-100111`, not `-100222`.

- [ ] **Step 4: Implement**

In `src/ports/ChannelSender.ts`, add to `SendRequest`:

```ts
  /** Overrides the sender's configured chat id. Set per outlet; absent = the configured one. */
  chatId?: string;
```

In `TelegramBotSender`, replace every use of the constructor chat id inside `send()` with a locally resolved one, computed once at the top of `send()`:

```ts
    const chatId = req.chatId ?? this.chatId;
```

Every `chat_id` in the method body — `sendMessage`, `sendPhoto`, `sendMediaGroup`, and the `t.me/c/<internal>/<id>` url derivation — must use this local `chatId`. Grep for `this.chatId` inside the class after editing; there should be no remaining uses in `send()`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test tests/adapters/send/TelegramBotSender.test.ts`
Expected: PASS — including every pre-existing test, unchanged (no `chatId` in the request means identical behaviour).

- [ ] **Step 6: Commit**

```bash
git add src/ports/ChannelSender.ts src/adapters/send/TelegramBotSender.ts tests/adapters/send/TelegramBotSender.test.ts
git commit -m "feat(send): let a send request override the Telegram chat id"
```

---

### Task 5: SendChannels delivers per outlet

**Files:**
- Modify: `src/app/SendChannels.ts`
- Modify: `src/cli/send-channels.ts`
- Test: `tests/app/SendChannels.test.ts` (extend)

**Interfaces:**
- Consumes: `DeliveryLedger` (Task 3), `loadTelegramChatIds` (Task 2), `ALL_OUTLETS`/`outletsForChannel` (Task 1), `SendRequest.chatId` (Task 4).
- Produces: `SendChannels` constructor takes `DeliveryLedger` in place of `ChannelLedger`, plus `outletsFor: (channel: Channel) => Outlet[]` and `chatIds: Record<string, string>`. `run()` gains `outletIds?: string[]` on its selector. `SendChannels` sends one message per **auto** outlet on the rendering's channel.

- [ ] **Step 1: Write the failing tests**

Add to `tests/app/SendChannels.test.ts` (reuse the file's existing fakes — read it first and match its helper names):

```ts
it("sends one message per auto outlet on the channel, and skips manual ones", async () => {
  const sent: { outlet?: string; chatId?: string }[] = [];
  const sender = {
    name: "telegram-bot",
    channel: "telegram" as const,
    send: async (req: { chatId?: string }) => {
      sent.push({ chatId: req.chatId });
      return { postId: "m1", url: "u" };
    },
  };
  const ledger = fakeDeliveryLedger();
  const uc = new SendChannels(
    formattingStore([approvedRendering("x:1", "announcement", "telegram", "본문")]),
    { telegram: sender }, ledger, () => "T",
    outletsForChannel, { "tg-community": "-100111", "tg-dev": "-100222" },
  );

  const res = await uc.run({ target: "telegram" });

  expect(res.sent).toBe(2); // tg-community + tg-dev; tg-kol and tg-blockchain are manual
  expect(sent.map((s) => s.chatId).sort()).toEqual(["-100111", "-100222"]);
  expect((await ledger.loadKeys()).size).toBe(2);
});

it("skips an auto outlet with no chat id configured, and still sends to the others", async () => {
  const sender = { name: "telegram-bot", channel: "telegram" as const, send: async () => ({ postId: "m1" }) };
  const ledger = fakeDeliveryLedger();
  const uc = new SendChannels(
    formattingStore([approvedRendering("x:1", "announcement", "telegram", "본문")]),
    { telegram: sender }, ledger, () => "T",
    outletsForChannel, { "tg-community": "-100111" },
  );

  const res = await uc.run({ target: "telegram" });

  expect(res.sent).toBe(1);
  expect([...(await ledger.loadKeys())]).toEqual(["x:1:announcement:tg-community"]);
});

it("does not re-send a room already in the ledger, but still sends its sibling room", async () => {
  const sender = { name: "telegram-bot", channel: "telegram" as const, send: async () => ({ postId: "m1" }) };
  const ledger = fakeDeliveryLedger([
    { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", at: "T", by: "auto" },
  ]);
  const uc = new SendChannels(
    formattingStore([approvedRendering("x:1", "announcement", "telegram", "본문")]),
    { telegram: sender }, ledger, () => "T",
    outletsForChannel, { "tg-community": "-100111", "tg-dev": "-100222" },
  );

  const res = await uc.run({ target: "telegram" });

  expect(res.sent).toBe(1);
  expect(res.skipped).toBe(1);
  expect([...(await ledger.loadKeys())].sort()).toEqual(["x:1:announcement:tg-community", "x:1:announcement:tg-dev"]);
});

it("restricts to the rooms named by --outlets", async () => {
  const sender = { name: "telegram-bot", channel: "telegram" as const, send: async () => ({ postId: "m1" }) };
  const ledger = fakeDeliveryLedger();
  const uc = new SendChannels(
    formattingStore([approvedRendering("x:1", "announcement", "telegram", "본문")]),
    { telegram: sender }, ledger, () => "T",
    outletsForChannel, { "tg-community": "-100111", "tg-dev": "-100222" },
  );

  const res = await uc.run({ target: "telegram", outletIds: ["tg-dev"] });

  expect(res.sent).toBe(1);
  expect([...(await ledger.loadKeys())]).toEqual(["x:1:announcement:tg-dev"]);
});
```

Add the fake near the file's other fakes:

```ts
function fakeDeliveryLedger(seed: DeliveryEntry[] = []) {
  let rows = [...seed];
  return {
    loadAll: async () => rows,
    loadKeys: async () => new Set(rows.map(deliveryKey)),
    add: async (e: DeliveryEntry) => {
      rows = [...rows.filter((r) => deliveryKey(r) !== deliveryKey(e)), e];
    },
    remove: async (key: string) => {
      rows = rows.filter((r) => deliveryKey(r) !== key);
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/app/SendChannels.test.ts`
Expected: FAIL — the constructor does not accept the outlet arguments.

- [ ] **Step 3: Implement**

In `src/app/SendChannels.ts`:

1. Replace the `ChannelLedger` constructor parameter with `DeliveryLedger`, and append two parameters after the existing ones (appending keeps every current call site's argument order valid until it is updated):

```ts
    private readonly outletsFor: (channel: Channel) => Outlet[] = outletsForChannel,
    private readonly chatIds: Record<string, string> = {},
```

2. Inside the per-rendering loop, replace the single send with a loop over the channel's auto outlets. Keep the existing over-limit guard, photo/video handling and error rules exactly as they are — only the key, the recipient and the loop are new:

```ts
      const outlets = this.outletsFor(r.channel).filter((o) => {
        if (o.delivery !== "auto") return false;
        if (selector.outletIds && !selector.outletIds.includes(o.id)) return false;
        return true;
      });

      for (const outlet of outlets) {
        const key = deliveryKey({ itemId: r.itemId, type: r.type, outletId: outlet.id });
        if (already.has(key)) {
          skipped++;
          continue;
        }
        const chatId = outlet.chatIdEnv ? this.chatIds[outlet.id] : undefined;
        if (outlet.chatIdEnv && !chatId) {
          console.warn(`[send] ${key} skipped: ${outlet.chatIdEnv} is not set`);
          continue;
        }
        // …existing send/record/archive body, with `chatId` passed on the send request
        // and `outletId: outlet.id` written to the ledger instead of `channel`.
      }
```

3. Add `outletIds?: string[]` to the run selector type.

- [ ] **Step 4: Wire the CLI**

In `src/cli/send-channels.ts`: construct `new JsonDeliveryLedger(paths.publishDir)` instead of `JsonChannelLedger`, pass `outletsForChannel` and `loadTelegramChatIds()`, and add an `--outlets` flag parsed with the shared `parseList(argValue("--outlets"))`. Interpolate the valid ids into the usage string from `ALL_OUTLETS` — never hardcode the list, per the #33 lesson.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. If a pre-existing `SendChannels` test now sends twice (two auto Telegram rooms where it used to send once), that is the intended behaviour change — update the expectation and leave a comment saying why, rather than restricting the fake to one outlet.

- [ ] **Step 6: Mutation-check the room isolation**

Change the ledger key back to `${itemId}:${type}:${channel}` and re-run. The "does not re-send a room already in the ledger, but still sends its sibling room" test must fail — it is the test that exists to catch exactly this. Revert.

- [ ] **Step 7: Commit**

```bash
git add src/app/SendChannels.ts src/cli/send-channels.ts tests/app/SendChannels.test.ts
git commit -m "feat(send): deliver per outlet, keyed by room instead of channel"
```

---

### Task 6: Marking a manual delivery

**Files:**
- Create: `src/app/MarkDelivery.ts`
- Test: `tests/app/MarkDelivery.test.ts`

**Interfaces:**
- Consumes: `DeliveryLedger` (Task 3), `outletById` (Task 1).
- Produces: `MarkDelivery` with `run({ itemId, type, outletId, delivered }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/app/MarkDelivery.test.ts
import { describe, expect, it } from "vitest";
import { MarkDelivery } from "../../src/app/MarkDelivery";
import { deliveryKey, type DeliveryEntry } from "../../src/domain/delivery/models";

function fakeLedger(seed: DeliveryEntry[] = []) {
  let rows = [...seed];
  return {
    loadAll: async () => rows,
    loadKeys: async () => new Set(rows.map(deliveryKey)),
    add: async (e: DeliveryEntry) => { rows = [...rows.filter((r) => deliveryKey(r) !== deliveryKey(e)), e]; },
    remove: async (key: string) => { rows = rows.filter((r) => deliveryKey(r) !== key); },
    rows: () => rows,
  };
}
const args = { itemId: "x:1", type: "announcement", outletId: "kakao-kol" };

describe("MarkDelivery", () => {
  it("records a manual delivery", async () => {
    const l = fakeLedger();
    await new MarkDelivery(l, () => "2026-07-29T00:00:00.000Z").run({ ...args, delivered: true });
    expect(l.rows()).toEqual([{ ...args, status: "delivered", by: "manual", at: "2026-07-29T00:00:00.000Z" }]);
  });

  it("unticks a manual delivery", async () => {
    const l = fakeLedger([{ ...args, status: "delivered", by: "manual", at: "T" }]);
    await new MarkDelivery(l, () => "T2").run({ ...args, delivered: false });
    expect(l.rows()).toEqual([]);
  });

  it("refuses to untick an auto send — a sent post cannot be unsent", async () => {
    const l = fakeLedger([{ itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", by: "auto", at: "T" }]);
    const uc = new MarkDelivery(l, () => "T2");
    await expect(uc.run({ itemId: "x:1", type: "announcement", outletId: "tg-community", delivered: false })).rejects.toThrow(/sent/i);
    expect(l.rows()).toHaveLength(1);
  });

  it("rejects an unknown outlet", async () => {
    const l = fakeLedger();
    await expect(new MarkDelivery(l, () => "T").run({ ...args, outletId: "nope", delivered: true })).rejects.toThrow(/unknown outlet/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/app/MarkDelivery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/app/MarkDelivery.ts
import { deliveryKey } from "../domain/delivery/models";
import { outletById } from "../domain/outlet/models";
import type { DeliveryLedger } from "../ports/DeliveryLedger";

export interface MarkDeliveryInput {
  itemId: string;
  type: string;
  outletId: string;
  delivered: boolean;
}

/**
 * Ticks or unticks 전달함 for a manual room. Only `delivered` rows are reversible — a `sent` row
 * records that a bot actually posted, and unticking it would invite a duplicate live post on the
 * next run.
 */
export class MarkDelivery {
  constructor(
    private readonly ledger: DeliveryLedger,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: MarkDeliveryInput): Promise<void> {
    const outlet = outletById(input.outletId);
    if (!outlet) throw new Error(`unknown outlet: ${input.outletId}`);

    const key = deliveryKey(input);
    if (!input.delivered) {
      const existing = (await this.ledger.loadAll()).find((e) => deliveryKey(e) === key);
      if (existing?.status === "sent") {
        throw new Error(`${key} was sent by ${existing.senderName ?? "a bot"} and cannot be unmarked`);
      }
      await this.ledger.remove(key);
      return;
    }

    await this.ledger.add({
      itemId: input.itemId,
      type: input.type,
      outletId: input.outletId,
      status: "delivered",
      by: "manual",
      at: this.now(),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/app/MarkDelivery.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Full verification and commit**

```bash
pnpm test && pnpm typecheck && pnpm typecheck:web
git add src/app/MarkDelivery.ts tests/app/MarkDelivery.test.ts
git commit -m "feat(delivery): mark and unmark a manual room delivery"
```

**This is the end of the backend slice.** The repo is releasable here: the ledger no longer conflates rooms, `send:channels --outlets` targets specific rooms, and manual deliveries can be recorded. Update `CHANGELOG.md` under `[Unreleased]` and stop, or continue to the board UI.

---

### Task 7: Per-outlet text override

**Files:**
- Create: `src/domain/outlet/override.ts`
- Create: `src/ports/OutletOverrideStore.ts`
- Create: `src/adapters/store/JsonOutletOverrideStore.ts`
- Create: `src/app/SaveOutletOverride.ts`
- Test: `tests/domain/outlet/override.test.ts`, `tests/app/SaveOutletOverride.test.ts`

**Interfaces:**
- Consumes: `ChannelRendering` from `src/domain/formatting/models`.
- Produces: `OutletOverride { itemId, type, outletId, text, status: "rendered" | "approved", createdAt, approvedAt? }`; `overrideKey(o): string`; `textFor(rendering, override): { text, status, forked }`; `OutletOverrideStore` port (`loadAll`, `upsert`, `remove`); `JsonOutletOverrideStore`; `SaveOutletOverride` with `run({ itemId, type, outletId, text?, approve?, revert? })`.

- [ ] **Step 1: Write the failing domain test**

```ts
// tests/domain/outlet/override.test.ts
import { describe, expect, it } from "vitest";
import { textFor } from "../../../src/domain/outlet/override";
import type { ChannelRendering } from "../../../src/domain/formatting/models";

const rendering: ChannelRendering = {
  itemId: "x:1", type: "announcement", channel: "telegram", text: "공통 원고",
  refined: false, createdAt: "T", status: "approved", approvedAt: "T2",
};

describe("textFor", () => {
  it("uses the group text when the room has no override", () => {
    expect(textFor(rendering, undefined)).toEqual({ text: "공통 원고", status: "approved", forked: false });
  });

  it("uses the room's own text and its own status when forked", () => {
    const override = { itemId: "x:1", type: "announcement", outletId: "tg-blockchain", text: "이 방 전용", status: "rendered" as const, createdAt: "T3" };
    expect(textFor(rendering, override)).toEqual({ text: "이 방 전용", status: "rendered", forked: true });
  });

  it("does not inherit the group's approval — a forked room starts unapproved", () => {
    const override = { itemId: "x:1", type: "announcement", outletId: "tg-blockchain", text: "이 방 전용", status: "rendered" as const, createdAt: "T3" };
    expect(rendering.status).toBe("approved");
    expect(textFor(rendering, override).status).toBe("rendered");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/domain/outlet/override.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the domain**

```ts
// src/domain/outlet/override.ts
import type { ChannelRendering } from "../formatting/models";

/**
 * One room's own copy of a rendering, stored only once the reviewer edits that room. Rooms with no
 * row here share the group text — the same shared-then-forked rule `FormatVariants` applies at the
 * channel layer, one level down.
 */
export interface OutletOverride {
  itemId: string;
  type: string;
  outletId: string;
  text: string;
  status: "rendered" | "approved";
  createdAt: string;
  approvedAt?: string;
}

export function overrideKey(o: Pick<OutletOverride, "itemId" | "type" | "outletId">): string {
  return `${o.itemId}:${o.type}:${o.outletId}`;
}

export interface ResolvedText {
  text: string;
  status: "rendered" | "approved";
  forked: boolean;
}

/** What a room actually sends: its override when it has one, else the group rendering. */
export function textFor(rendering: ChannelRendering, override: OutletOverride | undefined): ResolvedText {
  if (!override) return { text: rendering.text, status: rendering.status, forked: false };
  return { text: override.text, status: override.status, forked: true };
}
```

- [ ] **Step 4: Write the port, adapter and use-case**

```ts
// src/ports/OutletOverrideStore.ts
import type { OutletOverride } from "../domain/outlet/override";

export interface OutletOverrideStore {
  loadAll(): Promise<OutletOverride[]>;
  upsert(o: OutletOverride): Promise<void>;
  remove(key: string): Promise<void>;
}
```

```ts
// src/adapters/store/JsonOutletOverrideStore.ts
import { join } from "node:path";
import type { OutletOverride } from "../../domain/outlet/override";
import { overrideKey } from "../../domain/outlet/override";
import type { OutletOverrideStore } from "../../ports/OutletOverrideStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonOutletOverrideStore implements OutletOverrideStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "overrides.json");
  }
  loadAll(): Promise<OutletOverride[]> {
    return readJsonFile<OutletOverride[]>(this.path, []);
  }
  async upsert(o: OutletOverride): Promise<void> {
    const byKey = new Map((await this.loadAll()).map((e) => [overrideKey(e), e]));
    byKey.set(overrideKey(o), o);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }
  async remove(key: string): Promise<void> {
    const kept = (await this.loadAll()).filter((e) => overrideKey(e) !== key);
    await writeJsonFileAtomic(this.dir, this.path, kept);
  }
}
```

```ts
// src/app/SaveOutletOverride.ts
import { overrideKey, type OutletOverride } from "../domain/outlet/override";
import { outletById } from "../domain/outlet/models";
import type { OutletOverrideStore } from "../ports/OutletOverrideStore";

export interface SaveOutletOverrideInput {
  itemId: string;
  type: string;
  outletId: string;
  text?: string;
  approve?: boolean;
  /** Deletes the override so the room falls back to the group text and the group's approval. */
  revert?: boolean;
}

/**
 * Editing a room forks it; approving marks that fork reviewed; reverting un-forks it.
 * A fresh fork starts at `rendered` even when the group was approved — the text was just changed,
 * so it has not been reviewed in that form. Mirrors the existing rendering-edit rule.
 */
export class SaveOutletOverride {
  constructor(
    private readonly store: OutletOverrideStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: SaveOutletOverrideInput): Promise<OutletOverride | undefined> {
    if (!outletById(input.outletId)) throw new Error(`unknown outlet: ${input.outletId}`);
    const key = overrideKey(input);

    if (input.revert) {
      await this.store.remove(key);
      return undefined;
    }

    const existing = (await this.store.loadAll()).find((o) => overrideKey(o) === key);
    const at = this.now();

    if (input.approve) {
      if (!existing) throw new Error(`${key} has no override to approve — approve the group instead`);
      const approved: OutletOverride = { ...existing, status: "approved", approvedAt: at };
      await this.store.upsert(approved);
      return approved;
    }

    if (input.text === undefined) throw new Error(`${key}: nothing to save`);
    const saved: OutletOverride = {
      itemId: input.itemId, type: input.type, outletId: input.outletId,
      text: input.text, status: "rendered", createdAt: existing?.createdAt ?? at,
    };
    await this.store.upsert(saved);
    return saved;
  }
}
```

- [ ] **Step 5: Write the use-case test**

```ts
// tests/app/SaveOutletOverride.test.ts
import { describe, expect, it } from "vitest";
import { SaveOutletOverride } from "../../src/app/SaveOutletOverride";
import { overrideKey, type OutletOverride } from "../../src/domain/outlet/override";

function fakeStore(seed: OutletOverride[] = []) {
  let rows = [...seed];
  return {
    loadAll: async () => rows,
    upsert: async (o: OutletOverride) => { rows = [...rows.filter((r) => overrideKey(r) !== overrideKey(o)), o]; },
    remove: async (key: string) => { rows = rows.filter((r) => overrideKey(r) !== key); },
    rows: () => rows,
  };
}
const args = { itemId: "x:1", type: "announcement", outletId: "tg-blockchain" };

describe("SaveOutletOverride", () => {
  it("forks a room at rendered when its text is edited", async () => {
    const s = fakeStore();
    const saved = await new SaveOutletOverride(s, () => "T").run({ ...args, text: "이 방 전용" });
    expect(saved?.status).toBe("rendered");
    expect(s.rows()).toHaveLength(1);
  });

  it("keeps the original createdAt when the fork is edited again", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "rendered", createdAt: "T1" }]);
    const saved = await new SaveOutletOverride(s, () => "T2").run({ ...args, text: "v2" });
    expect(saved?.createdAt).toBe("T1");
  });

  it("re-forks to rendered when an approved fork is edited", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "approved", createdAt: "T1", approvedAt: "T1" }]);
    const saved = await new SaveOutletOverride(s, () => "T2").run({ ...args, text: "v2" });
    expect(saved?.status).toBe("rendered");
    expect(saved?.approvedAt).toBeUndefined();
  });

  it("approves an existing fork", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "rendered", createdAt: "T1" }]);
    const saved = await new SaveOutletOverride(s, () => "T2").run({ ...args, approve: true });
    expect(saved?.status).toBe("approved");
    expect(saved?.approvedAt).toBe("T2");
  });

  it("refuses to approve a room that was never forked", async () => {
    const s = fakeStore();
    await expect(new SaveOutletOverride(s, () => "T").run({ ...args, approve: true })).rejects.toThrow(/no override/i);
  });

  it("reverts a fork so the room falls back to the group text", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "rendered", createdAt: "T1" }]);
    await new SaveOutletOverride(s, () => "T2").run({ ...args, revert: true });
    expect(s.rows()).toEqual([]);
  });

  it("rejects an unknown outlet", async () => {
    const s = fakeStore();
    await expect(new SaveOutletOverride(s, () => "T").run({ ...args, outletId: "nope", text: "x" })).rejects.toThrow(/unknown outlet/i);
  });
});
```

- [ ] **Step 6: Run tests and verify**

Run: `pnpm test tests/domain/outlet/override.test.ts tests/app/SaveOutletOverride.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 7: Mutation-check the fork-resets-approval rule**

Change `status: "rendered"` in the save branch to `status: existing?.status ?? "rendered"` and re-run — "re-forks to rendered when an approved fork is edited" must fail. Revert.

- [ ] **Step 8: Commit**

```bash
git add src/domain/outlet/override.ts src/ports/OutletOverrideStore.ts src/adapters/store/JsonOutletOverrideStore.ts src/app/SaveOutletOverride.ts tests/domain/outlet/override.test.ts tests/app/SaveOutletOverride.test.ts
git commit -m "feat(outlet): per-room text override, forked on edit"
```

---

### Task 8: Board API

**Files:**
- Create: `src/adapters/web/board.ts`
- Modify: `src/adapters/web/apiHandlers.ts`
- Modify: `src/cli/serve.ts`
- Test: `tests/adapters/web/board.test.ts`

**Interfaces:**
- Consumes: `textFor`/`OutletOverride` (Task 7), `ALL_OUTLETS`/`outletsForChannel` (Task 1), `deliveryKey`/`DeliveryEntry` (Task 3), `MarkDelivery` (Task 6), `SaveOutletOverride` (Task 7), `FormattingStore`.
- Produces: `buildBoard(itemId, renderings, overrides, deliveries): BoardView`; `BoardView { itemId, groups: BoardGroup[], unconverted: ConversionType[] }`; `BoardGroup { type, channel, text, status, rows: BoardRow[], addableOutletIds: string[] }`; `BoardRow { outletId, label, delivery, forked, status, text, deliveryStatus?, at?, url?, siblingCount, siblingIndex }`. New routes on `handleApi`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/adapters/web/board.test.ts
import { describe, expect, it } from "vitest";
import { buildBoard } from "../../../src/adapters/web/board";
import type { ChannelRendering } from "../../../src/domain/formatting/models";

const r = (type: string, channel: string, text: string, status: "rendered" | "approved" = "approved"): ChannelRendering =>
  ({ itemId: "x:1", type, channel, text, refined: false, createdAt: "T", status } as ChannelRendering);

describe("buildBoard", () => {
  it("groups by (type, channel) and lists the rooms that receive each group", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], []);
    const group = board.groups.find((g) => g.type === "announcement" && g.channel === "telegram");
    expect(group?.text).toBe("공통");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-community", "tg-dev", "tg-blockchain"]);
  });

  it("rows the suggested rooms and offers the channel's remaining rooms as addable", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [], []);
    const group = board.groups.find((g) => g.type === "kol");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-kol"]);
    // suggestedTypes is a default, not a constraint — the rest of the channel stays reachable.
    expect(group?.addableOutletIds).toEqual(["tg-community", "tg-dev", "tg-blockchain"]);
  });

  it("rows a non-suggested room once it has a delivery, and drops it from addable", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [], [
      { itemId: "x:1", type: "kol", outletId: "tg-community", status: "delivered", at: "T", by: "manual" },
    ]);
    const group = board.groups.find((g) => g.type === "kol");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-kol", "tg-community"]);
    expect(group?.addableOutletIds).not.toContain("tg-community");
  });

  it("rows a non-suggested room once it has an override", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [
      { itemId: "x:1", type: "kol", outletId: "tg-dev", text: "데브방용", status: "rendered", createdAt: "T" },
    ], []);
    const group = board.groups.find((g) => g.type === "kol");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-kol", "tg-dev"]);
  });

  it("marks a forked room and gives it its own text and status", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [
      { itemId: "x:1", type: "announcement", outletId: "tg-blockchain", text: "이 방 전용", status: "rendered", createdAt: "T" },
    ], []);
    const rows = board.groups[0]!.rows;
    expect(rows.find((row) => row.outletId === "tg-blockchain")).toMatchObject({ forked: true, text: "이 방 전용", status: "rendered" });
    expect(rows.find((row) => row.outletId === "tg-community")).toMatchObject({ forked: false, text: "공통", status: "approved" });
  });

  it("attaches delivery state per room, keeping two rooms on one channel apart", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], [
      { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", at: "T", by: "auto", url: "u" },
    ]);
    const rows = board.groups[0]!.rows;
    expect(rows.find((row) => row.outletId === "tg-community")).toMatchObject({ deliveryStatus: "sent", url: "u" });
    expect(rows.find((row) => row.outletId === "tg-dev")?.deliveryStatus).toBeUndefined();
  });

  it("numbers a room that appears in several groups", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지"), r("explainer", "telegram", "해설")], [], []);
    const dev = board.groups.flatMap((g) => g.rows).filter((row) => row.outletId === "tg-dev");
    expect(dev.map((row) => [row.siblingIndex, row.siblingCount])).toEqual([[1, 2], [2, 2]]);
  });

  it("lists the types with no rendering yet", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], []);
    expect(board.unconverted).toEqual(["x", "explainer", "casual", "kol", "pr"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/web/board.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `buildBoard`**

Create `src/adapters/web/board.ts` as a **pure** function (no I/O — the caller loads the three stores). It must:

1. Group the item's renderings by `(type, channel)`, one `BoardGroup` each, carrying the group `text` and `status`.
2. For each group, row the outlets on that channel whose `suggestedTypes` include the group's `type`, **then append any other outlet on that channel that already has an override or a delivery for this `(itemId, type)`** — suggestion is a default, not a constraint, so a room the operator reached for stays visible on every later load. `addableOutletIds` is the channel's remaining outlets: neither suggested nor already rowed. Rows keep `outletsForChannel` order within each of the two segments.
3. For each kept outlet, resolve `textFor(rendering, override)` and attach the matching `DeliveryEntry` (by `deliveryKey`) as `deliveryStatus` / `at` / `url`.
4. Compute `siblingIndex` / `siblingCount` per outlet across the **whole board**, in group order, so a room in two groups reads `1/2` then `2/2`.
5. Set `unconverted` to `ALL_TYPES` minus the types that have any rendering, preserving `ALL_TYPES` order.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/web/board.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Add the routes**

In `src/adapters/web/apiHandlers.ts`, extend `ApiDeps` with `loadBoard: (itemId: string) => Promise<BoardView>`, `saveOutletOverride: SaveOutletOverride`, `markDelivery: MarkDelivery`, `sendToOutlet: (itemId: string, type: string, outletId: string) => Promise<{ sent: number; failed: number; error?: string }>`. Then add, following the file's existing `segments`-matching style:

```
GET  /api/items/:id/board
PUT  /api/outlets/:itemId/:type/:outletId          body { text } | { approve: true } | { revert: true }
POST /api/outlets/:itemId/:type/:outletId/send
POST /api/outlets/:itemId/:type/:outletId/mark     body { delivered: boolean }
```

Note `itemId` contains a colon (`x:123`), which is already handled elsewhere in this file — copy the existing decoding approach rather than inventing one.

In `src/cli/serve.ts`, construct `JsonOutletOverrideStore(paths.formattedDir)`, `JsonDeliveryLedger(paths.publishDir)`, `SaveOutletOverride`, `MarkDelivery`, and a `sendToOutlet` closure that runs `SendChannels` restricted to `{ ids: [itemId], types: [type], outletIds: [outletId] }`.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test && pnpm typecheck
git add src/adapters/web/board.ts src/adapters/web/apiHandlers.ts src/cli/serve.ts tests/adapters/web/board.test.ts
git commit -m "feat(dashboard): board API — groups, rooms, overrides, delivery"
```

---

### Task 9: Board UI

**Files:**
- Create: `web/src/components/OutletBoard.tsx`
- Create: `web/src/components/OutletCard.tsx`
- Modify: `web/src/types.ts`, `web/src/api.ts`, `web/src/components/RenderingsView.tsx`
- Test: manual verification with Playwright

**Interfaces:**
- Consumes: the Task 8 routes.
- Produces: `OutletBoard` rendering the selected item's groups; `RenderingsView` switches its right pane to it.

- [ ] **Step 1: Mirror the board types**

Add `BoardView` / `BoardGroup` / `BoardRow` and an `OUTLET_LABEL: Record<string, string>` to `web/src/types.ts`, and extend `tests/web/typeMirror.test.ts` with a case asserting `OUTLET_LABEL` covers every `ALL_OUTLETS` id with the same label — the mirror is only safe because that test exists.

- [ ] **Step 2: Add the API calls**

In `web/src/api.ts`: `board(itemId)`, `editOutlet(itemId, type, outletId, text)`, `approveOutlet(...)`, `revertOutlet(...)`, `sendOutlet(...)`, `markOutlet(itemId, type, outletId, delivered)`.

- [ ] **Step 3: Build `OutletCard`**

One card per group: header shows `타입 · 채널` and the group status, body shows the group text with `저장` / `승인 ✓` / `복사`, then one row per room — label, `자동`/`수동`, `n/m` when `siblingCount > 1`, `✎따로` when forked, and the action for its state:

| Row state | Action |
| --- | --- |
| group not approved | `[발송]` / `[전달함]` disabled with 🔒 |
| approved + auto | `[발송]` — `window.confirm` first, the post is irreversible |
| approved + manual | `[복사]` and `[전달함 ☐]` |
| `sent` | link, no action |
| `delivered` | `[전달함 ☑]` with the date, untickable |

A forked row expands to its own textarea with `저장` / `승인 ✓` / `그룹 글로 되돌리기`.

Below the rows, a `+ 다른 방 추가` control lists `addableOutletIds` by label. Picking one appends a row locally — nothing is stored yet, because there is nothing to store until the operator acts. The moment that row is sent, ticked, or forked, the delivery ledger or the override store holds it, and `buildBoard` rows it on every later load. This is how `suggestedTypes` stays a default rather than a constraint without inventing a fourth store.

- [ ] **Step 4: Build `OutletBoard`**

Fetches `board(itemId)`, renders the summary line (`수신처 N곳 · M건 중 K건 완료` plus per-room progress), the cards, and a collapsed `아직 변환 안 됨` line listing `unconverted` type labels. Hovering a row highlights every row with the same `outletId`.

- [ ] **Step 5: Wire it in and verify live**

Point `RenderingsView`'s right pane at `OutletBoard`. Then:

```bash
pnpm build:web && pnpm serve
```

Check with Playwright (screenshots under `.playwright-mcp/`, never the scratchpad): a group card renders with its rooms; forking a room shows `✎따로` and its own text; `승인` unlocks the row actions; ticking `전달함` persists across reload; a `sent` row cannot be unticked; `아직 변환 안 됨` lists the right types.

- [ ] **Step 6: Commit**

```bash
pnpm test && pnpm typecheck && pnpm typecheck:web && pnpm build:web
git add web/src tests/web/typeMirror.test.ts
git commit -m "feat(dashboard): outlet board UI"
```

---

### Task 10: Conversion and format triggers

**Files:**
- Create: `src/app/PrepareConversionRun.ts`
- Modify: `src/adapters/web/apiHandlers.ts`, `src/cli/serve.ts`, `web/src/components/OutletBoard.tsx`
- Test: `tests/app/PrepareConversionRun.test.ts`

**Interfaces:**
- Consumes: `PrepareConversions`, `FormatVariants` (both already exist and are already used by the CLIs).
- Produces: `PrepareConversionRun.run({ itemId, types }): Promise<{ worksheetPath: string; pending: number }>`; routes `POST /api/items/:id/convert-prepare` and `POST /api/items/:id/format`.

The board cannot convert — the tool has no Claude API and worksheets are filled by the local agent — so `[변환 준비]` writes the worksheet and reports where it landed. `[포맷]` is different: `FormatVariants` is pure code, so that button really does the work.

- [ ] **Step 1: Write the failing test**

```ts
// tests/app/PrepareConversionRun.test.ts
import { describe, expect, it } from "vitest";
import { PrepareConversionRun } from "../../src/app/PrepareConversionRun";

describe("PrepareConversionRun", () => {
  it("writes the worksheet for the requested item and types and reports the path", async () => {
    const written: { path: string; body: string }[] = [];
    const prepare = { run: async () => ({ worksheet: "## 유형: 공지", pending: [{ itemId: "x:1", type: "announcement", sourceKorean: "승인" }] }) };
    const uc = new PrepareConversionRun(prepare as never, async (p, b) => { written.push({ path: p, body: b }); }, "/ws", () => "STAMP");

    const res = await uc.run({ itemId: "x:1", types: ["announcement"] });

    expect(res.pending).toBe(1);
    expect(res.worksheetPath).toBe("/ws/batch-STAMP.md");
    expect(written[0]?.body).toContain("## 유형: 공지");
  });

  it("does not write a worksheet when nothing is pending", async () => {
    const written: string[] = [];
    const prepare = { run: async () => ({ worksheet: "", pending: [] }) };
    const uc = new PrepareConversionRun(prepare as never, async (p) => { written.push(p); }, "/ws", () => "STAMP");

    const res = await uc.run({ itemId: "x:1", types: ["announcement"] });

    expect(res.pending).toBe(0);
    expect(written).toEqual([]);
  });

  it("passes the item and types through as a selector", async () => {
    let seen: unknown;
    const prepare = { run: async (sel: unknown) => { seen = sel; return { worksheet: "w", pending: [{ itemId: "x:1", type: "casual", sourceKorean: "s" }] }; } };
    const uc = new PrepareConversionRun(prepare as never, async () => {}, "/ws", () => "S");

    await uc.run({ itemId: "x:1", types: ["casual", "explainer"] });

    expect(seen).toEqual({ ids: ["x:1"], types: ["casual", "explainer"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/app/PrepareConversionRun.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/app/PrepareConversionRun.ts
import type { ConversionType } from "../domain/conversion/models";
import type { PrepareConversions } from "./PrepareConversions";

/**
 * Runs `convert:prepare` on behalf of the dashboard. The board stops here on purpose: filling the
 * worksheet is the local agent's job (no Claude API in this tool), so the button prepares the work
 * and the operator asks the agent to complete it.
 */
export class PrepareConversionRun {
  constructor(
    private readonly prepare: PrepareConversions,
    private readonly writeFile: (path: string, body: string) => Promise<void>,
    private readonly worksheetDir: string,
    private readonly stamp: () => string = () => new Date().toISOString().replace(/[:.]/g, "-"),
  ) {}

  async run(input: { itemId: string; types: ConversionType[] }): Promise<{ worksheetPath: string; pending: number }> {
    const { worksheet, pending } = await this.prepare.run({ ids: [input.itemId], types: input.types });
    if (pending.length === 0) return { worksheetPath: "", pending: 0 };
    const worksheetPath = `${this.worksheetDir}/batch-${this.stamp()}.md`;
    await this.writeFile(worksheetPath, worksheet);
    return { worksheetPath, pending: pending.length };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/app/PrepareConversionRun.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the routes and buttons**

In `apiHandlers.ts` add `POST /api/items/:id/convert-prepare` (body `{ types: string[] }` → `{ worksheetPath, pending }`) and `POST /api/items/:id/format` (body `{ types: string[] }` → `{ rendered: number, warnings }`), wired in `serve.ts` to `PrepareConversionRun` and a `FormatVariants` instance built the same way `src/cli/format.ts` builds it (same stores, same `xMaxWeighted`).

In `OutletBoard.tsx`, the collapsed `아직 변환 안 됨` line gets type checkboxes and a `[변환 준비]` button; after it returns, show `워크시트 준비됨 — 에이전트에게 변환을 요청하세요: <path>`. Each group card gets `[포맷 다시]`, which re-runs format for that type and refreshes the board.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test && pnpm typecheck && pnpm typecheck:web && pnpm build:web
git add src/app/PrepareConversionRun.ts src/adapters/web/apiHandlers.ts src/cli/serve.ts web/src tests/app/PrepareConversionRun.test.ts
git commit -m "feat(dashboard): prepare conversion worksheets and re-run format from the board"
```

---

### Task 11: Documentation

**Files:**
- Modify: `CHANGELOG.md`, `docs/ko/review.md`, `docs/ko/capabilities.md`, `docs/ko/team-runbook.md`, `docs/ko/setup/channels.md`

- [ ] **Step 1: CHANGELOG**

Add an `[Unreleased] / ### Added` entry covering the outlet concept, the ledger re-keying (**call the room-conflation bug out explicitly** — it is the reason the change exists), the per-room override, and the board. Add a `### Changed` note that `TELEGRAM_CHAT_ID` is deprecated in favour of `TELEGRAM_CHAT_ID_COMMUNITY` / `TELEGRAM_CHAT_ID_DEV`, with the fallback described.

- [ ] **Step 2: `docs/ko/review.md`**

Replace the 2차 section's description of a flat rendering list with the board: cards per `타입 · 채널`, rooms beneath, `✎따로` for a forked room, `발송` vs `복사`+`전달함`, and that a sent post cannot be untaken.

- [ ] **Step 3: `docs/ko/setup/channels.md`**

Document the per-room chat ids beside the existing T-1..4 Telegram steps: how to get each room's id, that a blank one means that room is skipped, and the legacy fallback.

- [ ] **Step 4: `capabilities.md` and `team-runbook.md`**

Update the §8 rows to say delivery is per room, and add `--outlets` to the runbook's send step.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/
git commit -m "docs: outlet board — per-room delivery"
```

---

## Self-Review

**Spec coverage.** `Outlet` model → Task 1. Chat ids and the staged `.env` migration → Task 2. Ledger re-key and legacy migration → Task 3. Per-outlet sending → Tasks 4–5. Manual `delivered` tracking → Task 6. Per-outlet override with fork-on-edit, fork-starts-unapproved and un-forking → Task 7. The four routes and `buildBoard` → Task 8. The card screen, `n/m`, sibling highlight, `✎따로`, collapsed unconverted line → Task 9. `[변환 준비]` / `[포맷]` → Task 10. Docs → Task 11. Every spec section maps to a task.

**Known gap, deliberate.** The `pr-mail` outlet has no sender (none exists) — Task 9's row-states table leaves its send button disabled, matching the spec's "renders but its send button stays disabled". This is the spec's own non-goal, not a plan omission.

**Gap found and closed during this review.** The first draft ended at Task 9 and showed `아직 변환 안 됨` as status only, silently dropping the spec's `[변환 준비]` and `[포맷]` buttons. Task 10 now implements both — `PrepareConversionRun` writes the worksheet (the agent still fills it, since there is no Claude API here) and the format button runs `FormatVariants` directly, which is pure code.

**Type consistency.** `deliveryKey` takes `{itemId, type, outletId}` in Tasks 3, 5, 6 and 8. `overrideKey` takes `{itemId, type, outletId}` in Task 7. `textFor(rendering, override)` has the same signature in Tasks 7 and 8. `outletsForChannel(channel)` is used identically in Tasks 1, 5 and 8. `SendChannels`'s new parameters are appended in Task 5 and consumed with that order in Task 8's `serve.ts` wiring.
