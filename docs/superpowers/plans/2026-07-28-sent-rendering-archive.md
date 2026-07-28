# Sent-rendering Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `send:channels` actually sends an approved rendering, best-effort archive the final 공지 as a browsable document — local mode → `output/publish/local/sent/`, cloud mode → Drive `sent/` folder (Google + Lark) — parallel to how translations land in review/approved. The send stays authoritative; archiving can never break, block, or alter it.

**Architecture:** Extend `FolderKind` with `"sent"` so the existing uploaders route to a sent folder; add pure `renderSent`/`sentFileName` doc builders; add an optional best-effort `archive` hook to `SendChannels` (exactly parallel to the existing Sheet-history `record`); wire it in the CLI with a mode-aware `buildArchiver`. Cloud sent-folder ids are optional env vars, so existing setups keep sending and only skip the new archive until provisioned.

**Tech Stack:** ESM TypeScript, `vitest`, `zod`-only runtime dep (this feature adds none). Reuses `GoogleDriveUploader`/`LarkDriveUploader`/`LocalFileUploader`, native `fetch`.

## Global Constraints

- Runtime deps stay **zod-only**; no new dependency.
- The send is authoritative: archiving is **best-effort** — a disk/Drive failure warns and is swallowed, never throws out of `SendChannels`, never changes the sent/skipped/failed counts, never re-sends.
- Mode symmetry: local → `output/publish/local/sent/`, cloud → Drive `sent/` on **both** Google and Lark.
- Non-breaking: `GDRIVE_SENT_FOLDER_ID` / `LARK_DRIVE_SENT_FOLDER_TOKEN` are **optional**; when a cloud sent folder is unconfigured, that drive is skipped for archiving (the send still happens).
- Only the sendable channels (`telegram`, `x`) reach the archive; `kakao`/`pr_mail` are out of scope.
- Public repo: tests use synthetic English/Korean strings only — no real post text, tokens, or folder ids.
- Every test can fail: pin exact document text, filenames, and call counts.

---

## File Structure

- **Modify** `src/domain/publish/publishModels.ts` — `FolderKind` gains `"sent"`.
- **Modify** `src/adapters/drive/GoogleDriveUploader.ts` — `folders` → `Partial<Record<FolderKind, string>>` + undefined-folder guard.
- **Modify** `src/adapters/drive/LarkDriveUploader.ts` — same `Partial` + guard.
- **Modify** `src/domain/send/channels.ts` — add `SentArchiveEntry`.
- **Modify** `src/domain/publish/renderers.ts` — add `renderSent`, `sentFileName`.
- **Modify** `src/app/SendChannels.ts` — add `Archiver` type + optional `archive?` param + best-effort call.
- **Modify** `src/config.ts` — optional `sentFolderId` / `sentFolderToken`.
- **Create** `src/cli/archiver.ts` — pure `sentArchiveTargets` + `buildArchiver`.
- **Modify** `src/cli/send-channels.ts` — wire `buildArchiver`.
- **Modify** `src/cli/drive-init.ts` — provision the Google `sent/` folder, print its id.
- **Modify** `.env.example` and `docs/ko` — document the two vars and the `sent/` archive.
- **Test:** extend `tests/adapters/drive/{googleDriveUploader,larkDriveUploader,localFileUploader}.test.ts`, `tests/app/sendChannels.test.ts`; create `tests/domain/publish/sentRenderers.test.ts`, `tests/cli/archiver.test.ts`.

---

## Task 1: `FolderKind` gains `"sent"`; Drive uploaders take a `Partial` folder map with a guard

**Files:** Modify `src/domain/publish/publishModels.ts`, `src/adapters/drive/GoogleDriveUploader.ts`, `src/adapters/drive/LarkDriveUploader.ts`; Test `tests/adapters/drive/{googleDriveUploader,larkDriveUploader,localFileUploader}.test.ts`

**Interfaces:**
- Produces: `FolderKind = "review" | "approved" | "sent"`. `GoogleDriveUploader`/`LarkDriveUploader` constructors accept `folders: Partial<Record<FolderKind, string>>` and throw `"<Name>: no folder configured for \"<kind>\""` when a requested folder is absent.

- [ ] **Step 1: Write failing tests.** Add to `tests/adapters/drive/googleDriveUploader.test.ts`:

```ts
  it("maps the sent folder", async () => {
    const cap: { body?: string } = {};
    const uploader = new GoogleDriveUploader(auth, { sent: "SENT_FOLDER" }, fakeFetch(cap));
    await uploader.upload({ name: "x-1-telegram.md", content: "c", folder: "sent" });
    expect(cap.body).toContain('"parents":["SENT_FOLDER"]');
  });

  it("throws when the requested folder is not configured", async () => {
    const uploader = new GoogleDriveUploader(auth, { sent: "SENT_FOLDER" }, fakeFetch({}));
    await expect(uploader.upload({ name: "n", content: "c", folder: "review" })).rejects.toThrow(
      /no folder configured for "review"/,
    );
  });
```

Add to `tests/adapters/drive/larkDriveUploader.test.ts` (match its existing fixture names for auth/fetch; assert the sent token is the `parent_node` and that an unconfigured folder throws `/no folder configured for "review"/`).

Add to `tests/adapters/drive/localFileUploader.test.ts`:

```ts
  it("writes a sent doc under sent/", async () => {
    const uploader = new LocalFileUploader(root);
    const result = await uploader.upload({ name: "x-1-telegram.md", content: "공지", folder: "sent" });
    expect(result).toEqual({ id: join("sent", "x-1-telegram.md"), name: "x-1-telegram.md" });
    expect(await readFile(join(root, "sent", "x-1-telegram.md"), "utf8")).toBe("공지");
  });
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run tests/adapters/drive/` → the sent/guard cases FAIL (folder type rejects `"sent"`, or no guard).

- [ ] **Step 3: Implement.**

`src/domain/publish/publishModels.ts`:
```ts
export type FolderKind = "review" | "approved" | "sent";
```

`src/adapters/drive/GoogleDriveUploader.ts` — change the constructor param type and add the guard in `upload` (the `update` path only carries `name`, no parents, so it needs no folder lookup):
```ts
  constructor(
    private readonly auth: TokenSource,
    private readonly folders: Partial<Record<FolderKind, string>>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async upload(req: UploadRequest): Promise<UploadResult> {
    const token = await this.auth.getToken();
    const parent = this.folders[req.folder];
    if (!parent) throw new Error(`GoogleDriveUploader: no folder configured for "${req.folder}"`);
    const { boundary, body } = multipartBody({ name: req.name, parents: [parent] }, req.content);
    // ...rest unchanged
```

`src/adapters/drive/LarkDriveUploader.ts` — same treatment in `upload`:
```ts
  constructor(
    private readonly auth: TokenSource,
    private readonly baseUrl: string,
    private readonly folders: Partial<Record<FolderKind, string>>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async upload(req: UploadRequest): Promise<UploadResult> {
    const token = await this.auth.getToken();
    const parent = this.folders[req.folder];
    if (!parent) throw new Error(`LarkDriveUploader: no folder configured for "${req.folder}"`);
    const bytes = Buffer.from(req.content, "utf8");
    const form = new FormData();
    form.append("file_name", req.name);
    form.append("parent_type", "explorer");
    form.append("parent_node", parent);
    // ...rest unchanged
```

- [ ] **Step 4: Run to verify pass** — `pnpm exec vitest run tests/adapters/drive/` → green, including the pre-existing review/approved cases (they still pass: `{ review, approved }` satisfies `Partial<Record<FolderKind, string>>`).

- [ ] **Step 5: Typecheck.** `pnpm exec tsc --noEmit` → passes. `src/cli/uploaders.ts` builds uploaders with `{ review, approved }`, which is a valid `Partial<Record<FolderKind, string>>`, so it needs no change. If tsc reports any other `Record<FolderKind, string>` site newly missing `sent`, that site is a **publish** uploader that legitimately has only review/approved — change its annotation to `Partial<...>`, do not add a fake sent id.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(publish): add a 'sent' FolderKind; drive uploaders take a partial folder map"`

---

## Task 2: `SentArchiveEntry` + `renderSent` + `sentFileName`

**Files:** Modify `src/domain/send/channels.ts`, `src/domain/publish/renderers.ts`; Test `tests/domain/publish/sentRenderers.test.ts`

**Interfaces:**
- Produces: `SentArchiveEntry { itemId: string; type: ConversionType; channel: SendableChannel; text: string; postId?: string; url?: string; sentAt: string }` (in `domain/send/channels.ts`). `renderSent(e: SentArchiveEntry): string`, `sentFileName(e: Pick<SentArchiveEntry, "itemId" | "channel" | "sentAt">): string` (in `domain/publish/renderers.ts`).
- Note: `domain/send/channels.ts` imports only `domain/formatting` today; adding `ConversionType` from `domain/conversion/models` introduces no cycle (conversion does not import send). `renderers.ts` (domain/publish) importing the type from `domain/send` is a one-way edge (send does not import publish).

- [ ] **Step 1: Write the failing test** (`tests/domain/publish/sentRenderers.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { renderSent, sentFileName } from "../../../src/domain/publish/renderers";
import type { SentArchiveEntry } from "../../../src/domain/send/channels";

const base: SentArchiveEntry = {
  itemId: "x:2080608995371597892", type: "announcement", channel: "telegram",
  text: "📢 **맨틀 Q2**\n\n본문", postId: "10", url: undefined, sentAt: "2026-07-28T01:34:42.000Z",
};

describe("renderSent", () => {
  it("renders the metadata header + body, with — for a missing url", () => {
    expect(renderSent(base)).toBe(
      "# x:2080608995371597892 · telegram (announcement)\n\n" +
        "- sent: 2026-07-28T01:34:42.000Z\n" +
        "- postId: 10\n" +
        "- url: —\n\n" +
        "---\n\n" +
        "📢 **맨틀 Q2**\n\n본문\n",
    );
  });

  it("shows a present url and a — for a missing postId", () => {
    const doc = renderSent({ ...base, url: "https://t.me/c/1/10", postId: undefined });
    expect(doc).toContain("- postId: —\n");
    expect(doc).toContain("- url: https://t.me/c/1/10\n");
  });
});

describe("sentFileName", () => {
  it("is <sentDate>-<safeItemId>-<channel>.md with the id sanitized", () => {
    expect(sentFileName(base)).toBe("2026-07-28-x-2080608995371597892-telegram.md");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run tests/domain/publish/sentRenderers.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement.**

In `src/domain/send/channels.ts` add the import and type:
```ts
import type { ConversionType } from "../conversion/models";

export interface SentArchiveEntry {
  itemId: string;
  type: ConversionType;
  channel: SendableChannel;
  text: string;
  postId?: string;
  url?: string;
  sentAt: string;
}
```

In `src/domain/publish/renderers.ts` add (import the type at the top: `import type { SentArchiveEntry } from "../send/channels";`):
```ts
/** Sent doc: the final 공지 that went out, with its send metadata (2차 완성본). */
export function renderSent(e: SentArchiveEntry): string {
  return (
    `# ${e.itemId} · ${e.channel} (${e.type})\n\n` +
    `- sent: ${e.sentAt}\n` +
    `- postId: ${e.postId ?? "—"}\n` +
    `- url: ${e.url ?? "—"}\n\n` +
    `---\n\n` +
    `${e.text}\n`
  );
}

/** "<sentDate>-<safeItemId>-<channel>.md" — browsable, and needs no translation lookup at send time. */
export function sentFileName(e: Pick<SentArchiveEntry, "itemId" | "channel" | "sentAt">): string {
  const date = e.sentAt.slice(0, 10);
  const id = e.itemId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${date}-${id}-${e.channel}.md`;
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm exec vitest run tests/domain/publish/sentRenderers.test.ts` → 3/3.

- [ ] **Step 5: Typecheck + commit.** `pnpm exec tsc --noEmit`, then `git add -A && git commit -m "feat(publish): renderSent + sentFileName for the sent-rendering archive"`

---

## Task 3: `SendChannels` best-effort archive hook

**Files:** Modify `src/app/SendChannels.ts`; Test `tests/app/sendChannels.test.ts`

**Interfaces:**
- Consumes: `SentArchiveEntry` from `domain/send/channels` (Task 2).
- Produces: `export type Archiver = (entry: SentArchiveEntry) => Promise<void>`. `SendChannels` constructor gains a **5th** param `archive?: Archiver` (after `record`, before `now`). It is called after a successful send + ledger write, in its own try/catch; a throw is warned and swallowed and does not change the counts.

- [ ] **Step 1: Write the failing tests** — add to `tests/app/sendChannels.test.ts` (reuse its `rendering`, `fakeStore`, `fakeLedger`, `okSender`):

```ts
  it("archives each successful send once, with the rendering's text and send metadata", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram", text: "공지1" }),
      rendering({ itemId: "x:2", channel: "telegram", status: "rendered" }), // not approved → not archived
    ]);
    const { ledger } = fakeLedger();
    const archived: unknown[] = [];
    const sender: ChannelSender = { name: "telegram", send: async () => ({ postId: "p9", url: "u9" }) };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, async (e) => {
      archived.push(e);
    }).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(archived).toEqual([
      { itemId: "x:1", type: "announcement", channel: "telegram", text: "공지1", postId: "p9", url: "u9", sentAt: expect.any(String) },
    ]);
  });

  it("does not archive a skipped (already-sent) rendering", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger } = fakeLedger();
    await ledger.add({ itemId: "x:1", type: "announcement", channel: "telegram", senderName: "telegram", sentAt: "t" });
    let archives = 0;
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, undefined, async () => {
      archives++;
    }).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(archives).toBe(0);
  });

  it("a best-effort archive failure does not fail the send", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger, added } = fakeLedger();
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, undefined, async () => {
      throw new Error("disk full");
    }).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(added.map((e) => e.itemId)).toEqual(["x:1"]); // send + ledger stood; only the archive failed
  });
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run tests/app/sendChannels.test.ts` → the 3 new cases FAIL (constructor has no archive param / arity).

- [ ] **Step 3: Implement** — in `src/app/SendChannels.ts`:

Add the import and type (near the existing `Recorder` type):
```ts
import type { ChannelSentEntry, SendableChannel, SentArchiveEntry } from "../domain/send/channels";
// ...
export type Archiver = (entry: SentArchiveEntry) => Promise<void>;
```

Add the constructor param after `record`:
```ts
  constructor(
    private readonly store: FormattingStore,
    private readonly senders: Record<SendableChannel, ChannelSender | undefined>,
    private readonly ledger: ChannelLedger,
    private readonly record?: Recorder,
    private readonly archive?: Archiver,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
```

In `run`, after the `if (this.record) { ... }` block and before `sent += 1;`, add the third best-effort side-effect:
```ts
        if (this.archive) {
          try {
            await this.archive({ itemId: r.itemId, type: r.type, channel: r.channel, text: r.text, postId: res.postId, url: res.url, sentAt });
          } catch (err) {
            console.warn(`[send] ${key} sent, but archive failed: ${(err as Error).message}`);
          }
        }
```

- [ ] **Step 4: Run to verify pass, AND the pre-existing SendChannels tests still pass** — `pnpm exec vitest run tests/app/sendChannels.test.ts` → all green. The pre-existing cases construct `SendChannels` with ≤4 args, so the new optional 5th param is a no-op there (`now` still defaults — it moved to the 6th position but is only ever supplied positionally in tests that pass 4 or 5 args; if any pre-existing test passed a custom `now` as the 5th arg it must move to the 6th — check and fix if so).

- [ ] **Step 5: Typecheck + commit.** `pnpm exec tsc --noEmit`, then `git add -A && git commit -m "feat(send): best-effort sent-rendering archive hook in SendChannels"`

---

## Task 4: config sent fields + `buildArchiver` + wire `send-channels.ts`

**Files:** Modify `src/config.ts`, `src/cli/send-channels.ts`; Create `src/cli/archiver.ts`; Test `tests/cli/archiver.test.ts`

**Interfaces:**
- Consumes: `sentArchiveTargets`, `renderSent`/`sentFileName` (Task 2), `Archiver` (Task 3), the uploaders (Task 1).
- Produces: `sentArchiveTargets(mode: StorageMode, configured: { google: boolean; lark: boolean }): ("local" | "google" | "lark")[]` (pure, tested); `buildArchiver(): Promise<Archiver | undefined>`. `GoogleDriveConfig` gains optional `sentFolderId`; `LarkDriveConfig` gains optional `sentFolderToken`.

- [ ] **Step 1: Write the failing test** (`tests/cli/archiver.test.ts`) — the pure target-selection logic (mirrors `tests/cli/uploaders.test.ts` for `resolveTargets`):

```ts
import { describe, it, expect } from "vitest";
import { sentArchiveTargets } from "../../src/cli/archiver";

describe("sentArchiveTargets", () => {
  it("local mode archives to the local folder only", () => {
    expect(sentArchiveTargets("local", { google: true, lark: true })).toEqual(["local"]);
  });
  it("cloud mode archives to whichever drives have a sent folder configured", () => {
    expect(sentArchiveTargets("cloud", { google: true, lark: true })).toEqual(["google", "lark"]);
    expect(sentArchiveTargets("cloud", { google: true, lark: false })).toEqual(["google"]);
    expect(sentArchiveTargets("cloud", { google: false, lark: false })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run tests/cli/archiver.test.ts` → FAIL (module/export missing).

- [ ] **Step 3: Implement config fields.** In `src/config.ts`:

`GoogleDriveConfig` interface + `loadGoogleDriveConfig` return — add:
```ts
  // interface GoogleDriveConfig
  sentFolderId?: string;
```
```ts
  // end of loadGoogleDriveConfig
  return { reviewFolderId, approvedFolderId, sentFolderId: process.env.GDRIVE_SENT_FOLDER_ID?.trim() || undefined };
```
`LarkDriveConfig` interface + `loadLarkDriveConfig` return — add:
```ts
  // interface LarkDriveConfig
  sentFolderToken?: string;
```
```ts
  // in the returned object of loadLarkDriveConfig
  sentFolderToken: process.env.LARK_DRIVE_SENT_FOLDER_TOKEN?.trim() || undefined,
```

- [ ] **Step 4: Implement `src/cli/archiver.ts`** (mirrors `src/cli/recorder.ts`'s try/undefined pattern; uses `sentArchiveTargets` for the tested decision):

```ts
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleDriveUploader } from "../adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../adapters/drive/LarkDriveUploader";
import { LocalFileUploader } from "../adapters/drive/LocalFileUploader";
import { renderSent, sentFileName } from "../domain/publish/renderers";
import { loadGoogleAuthConfig, loadGoogleDriveConfig, loadLarkDriveConfig, loadStorageMode } from "../config";
import type { Archiver } from "../app/SendChannels";
import type { DriveUploader } from "../ports/DriveUploader";
import type { StorageMode } from "../storage/mode";
import { paths } from "../paths";

/** Which drives receive the sent-rendering archive: local mode → the filesystem; cloud mode → each
 *  drive that has a sent folder configured. Pure so the mode/config matrix is unit-testable. */
export function sentArchiveTargets(
  mode: StorageMode,
  configured: { google: boolean; lark: boolean },
): ("local" | "google" | "lark")[] {
  if (mode === "local") return ["local"];
  const targets: ("google" | "lark")[] = [];
  if (configured.google) targets.push("google");
  if (configured.lark) targets.push("lark");
  return targets;
}

function tryLoad<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Best-effort sent-rendering archiver: undefined unless at least one target is available, so a send
 *  works with no archive configured. Symmetric with buildRecorder (§9b). */
export async function buildArchiver(): Promise<Archiver | undefined> {
  const mode = loadStorageMode();
  const g = tryLoad(loadGoogleDriveConfig);
  const l = tryLoad(loadLarkDriveConfig);
  const targets = sentArchiveTargets(mode, { google: !!g?.sentFolderId, lark: !!l?.sentFolderToken });
  if (targets.length === 0) return undefined;

  const uploaders: DriveUploader[] = [];
  for (const t of targets) {
    if (t === "local") {
      uploaders.push(new LocalFileUploader(paths.publishLocalDir));
    } else if (t === "google") {
      uploaders.push(new GoogleDriveUploader(await createGoogleAuth(loadGoogleAuthConfig()), { sent: g!.sentFolderId }));
    } else {
      uploaders.push(new LarkDriveUploader(new LarkAuth(new HttpClient(l!.baseUrl), l!.appId, l!.appSecret), l!.baseUrl, { sent: l!.sentFolderToken }));
    }
  }

  return async (entry) => {
    const name = sentFileName(entry);
    const content = renderSent(entry);
    for (const u of uploaders) {
      try {
        await u.upload({ name, content, folder: "sent" });
      } catch (err) {
        console.warn(`[archive] ${entry.itemId}/${entry.channel} → ${u.name} failed: ${(err as Error).message}`);
      }
    }
  };
}
```

- [ ] **Step 5: Wire `src/cli/send-channels.ts`** — add the import and pass the archiver:
```ts
import { buildArchiver } from "./archiver";
// ...
const record = await buildRecorder();
const archive = await buildArchiver();

const result = await new SendChannels(store, senders, ledger, record, archive).run({ targets, ids });
```

- [ ] **Step 6: Run to verify pass** — `pnpm exec vitest run tests/cli/archiver.test.ts` → 2/2. `pnpm exec tsc --noEmit` → passes.

- [ ] **Step 7: Local smoke test (real filesystem, no creds).**
```bash
HERALD_STORAGE_MODE=local pnpm send:channels --target telegram
```
Expected: the run completes; already-sent renderings skip; **no** archive is written for skipped items. (A live-send archive is exercised in the review round, not here — this only confirms the wiring loads and does not throw.) Report the observed output.

- [ ] **Step 8: Commit.** `git add -A && git commit -m "feat(send): buildArchiver wiring + optional sent-folder config"`

---

## Task 5: `drive:init` provisions the Google `sent/` folder; docs + `.env.example`

**Files:** Modify `src/cli/drive-init.ts`, `.env.example`, `docs/ko/team-runbook.md` (and `docs/ko/capabilities.md` if it enumerates publish folders)

**Interfaces:** Consumes `ensureFolder` (already in `drive-init.ts`). No new exports.

- [ ] **Step 1: Provision the sent folder** — in `src/cli/drive-init.ts`, after the `approved` folder line:
```ts
const sent = await ensureFolder("sent", parent.id);
```
Add to the console output, after the approved line:
```ts
console.log(`  sent:     ${sent.created ? "created" : "already exists"} → ${sent.id}`);
```
And in the final `.env` block, after `GDRIVE_APPROVED_FOLDER_ID`:
```ts
console.log(`GDRIVE_SENT_FOLDER_ID=${sent.id}`);
```

- [ ] **Step 2: Verify drive:init still type-checks and its shape is unchanged.** `pnpm exec tsc --noEmit`. (No unit test: `drive-init.ts` is CLI glue over `GoogleDriveProvisioner`, which is already covered by `tests/adapters/drive/googleDriveProvisioner.test.ts`; the `sent` folder uses the same `ensureFolder` path as review/approved.)

- [ ] **Step 3: Document the two vars in `.env.example`** — beside the existing Drive folder vars, add:
```
# Optional: the sent-rendering archive (2차 완성본). Leave unset to skip archiving in cloud mode.
# GDRIVE_SENT_FOLDER_ID=            # printed by `pnpm drive:init`
# LARK_DRIVE_SENT_FOLDER_TOKEN=     # create a `sent` folder in Lark by hand, paste its token
```
Match the file's existing comment/spacing style; if `.env.example` groups Google and Lark vars in separate sections, put each line in its section.

- [ ] **Step 4: Document the `sent/` archive** — in `docs/ko/team-runbook.md`, at the channel-send step (§ around "채널 발송"), add one sentence: 발송 시 실제 나간 공지가 2차 완성본으로 `output/publish/local/sent/`(local) 또는 Drive `sent/` 폴더(cloud, `GDRIVE_SENT_FOLDER_ID`/`LARK_DRIVE_SENT_FOLDER_TOKEN` 설정 시)에 best-effort로 아카이브된다 — 미설정이어도 발송은 그대로. If `docs/ko/capabilities.md` lists the publish folders (review/approved), add `sent`(2차 완성본) there too.

- [ ] **Step 5: Full suite + typecheck.** `pnpm test` and `pnpm exec tsc --noEmit` → green.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(publish): provision the Drive sent/ folder; document the sent-rendering archive"`

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (trigger = on send, sendable channels only) → Task 3 (archive inside `SendChannels`'s send-success branch; only telegram/x reach it) + Task 3 tests (skipped/approved-not-sent not archived).
- Decision 2 (mode-dependent: local folder / Drive both) → Task 4 `sentArchiveTargets` + `buildArchiver`, tested matrix.
- Decision 3 (best-effort) → Task 3 try/catch + "archive failure does not fail the send" test; Task 4 per-uploader try/catch.
- Decision 4 (reuse uploaders via `"sent"` FolderKind, `Partial` folder map + guard) → Task 1 + tests.
- Decision 5 (optional cloud sent folders, non-breaking) → Task 4 config (`|| undefined`) + `sentArchiveTargets` returning `[]` when unconfigured; Task 5 `.env.example` "leave unset".
- Decision 6 (doc format + `<date>-<id>-<channel>.md`, no source slug) → Task 2 `renderSent`/`sentFileName` + pinned tests.
- Architecture "drive:init provisions sent/" → Task 5. Docs/env → Task 5.

**2. Placeholder scan:** No TBD/TODO; every code and test step is complete and concrete.

**3. Type consistency:** `SentArchiveEntry` (Task 2) is the single shape consumed by `renderSent`/`sentFileName` (Task 2), `Archiver` (Task 3), and `buildArchiver` (Task 4). `FolderKind` (Task 1) with `"sent"` is used by `upload({ folder: "sent" })` in Task 4. `sentArchiveTargets` signature in the Task 4 test matches its implementation. `GoogleDriveConfig.sentFolderId?` / `LarkDriveConfig.sentFolderToken?` (Task 4) are read in `buildArchiver` (Task 4) and printed by `drive:init` (Task 5, Google only). `SendChannels`'s new 5th constructor param `archive?` is passed positionally in Task 4's `send-channels.ts` wiring, consistent with the constructor order (record, archive, now).
