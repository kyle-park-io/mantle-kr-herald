# Sent-rendering archive — 2차 완성본 문서 아카이브 — design

Date: 2026-07-28
Status: approved for planning
Scope: when `send:channels` actually sends an approved rendering to a channel (telegram/x), best-effort
archive the final 공지 as a browsable document — local mode → `output/publish/local/sent/`, cloud mode →
Drive `sent/` folder on Google + Lark. Symmetric with how approved translations are published to
review/approved. The send stays authoritative; the archive can never break or block it.

## Context

The pipeline branches at the approved translation:

- **`drive:publish`** (PublishTranslations) writes **translations** to Drive `review/`/`approved/`
  (mode-dependent: local mode → `output/publish/local/{review,approved}/`). The folder is chosen by the
  translation's 1차-검수 status. This is the "1차 완성본" document archive.
- **`send:channels`** (SendChannels) sends **channel renderings** (the 2차 완성본, the actual 공지) to
  Telegram/X and records the send in `output/publish/channels.json` (postId, url, sentAt).

The asymmetry: the 1차 완성본 (translation) lands as a browsable `.md` document, but the **2차 완성본
(the 공지 that actually went to the community) has no document archive** — it lives only as a
`status:"approved"` record inside `output/formatted/renderings.json`, plus a postId row in the send
ledger. "우리가 실제로 뭘 내보냈나"를 사람이 나중에 문서로 찾아볼 곳이 없다.

This feature closes that asymmetry: it gives the sent 공지 the same document-archive treatment the
translation already gets, in a `sent/` folder parallel to `review/`/`approved/`.

## Decisions

### 1. Trigger: on send (not on 2차 approval)

The archive fires **when a rendering is actually sent** — inside `SendChannels`, right after the send
succeeds and the ledger row is written. So `sent/` means "what actually went to the community," and each
document carries the send's `postId`/`url`. A rendering that is 2차-approved but never sent (or whose
send failed) is **not** archived. Only the sendable channels (`telegram`, `x`) reach the send path, so
`kakao`/`pr_mail` are out of scope (they have no send step).

### 2. Location: mode-dependent, symmetric with the translation publish

- **local mode** → `output/publish/local/sent/`
- **cloud mode** → Drive `sent/` folder on **both Google and Lark** (same drives translations go to)

This reuses the existing publish model (local mode writes files, cloud mode uploads to Drive) rather than
introducing a separate always-local path.

### 3. Best-effort — the archive never breaks the send

The send to Telegram/X is irreversible and authoritative. A disk/Drive failure while archiving must **not**
mark the send as failed (that would make the next run re-send it live) and must not throw out of
`SendChannels`. The archive is a third best-effort side-effect after a successful send, in its own
try/catch with a warning — exactly parallel to the existing best-effort Sheet-history `record` and the
ledger `add`.

### 4. Reuse the uploader mechanism via a new `"sent"` FolderKind

`FolderKind` gains `"sent"`. The existing uploaders then route to it with no new upload logic:

- `LocalFileUploader` already writes to `join(rootDir, req.folder, req.name)` → `folder:"sent"` lands in
  `output/publish/local/sent/` automatically (no change beyond the union).
- `GoogleDriveUploader` / `LarkDriveUploader` carry a `folders` map. Adding `"sent"` to `FolderKind` means
  a full `Record<FolderKind, string>` would newly require a `sent` entry everywhere — including the
  publish path, which only has review/approved. So the uploaders' `folders` type becomes
  **`Partial<Record<FolderKind, string>>`** with a runtime guard: `upload`/`update` throw a clear error if
  `folders[req.folder]` is undefined. Publish uploaders carry `{review, approved}`; the archive uploaders
  carry `{sent}`. No caller of the publish path changes behavior.

### 5. Cloud `sent/` folder ids are optional (non-breaking)

`GDRIVE_SENT_FOLDER_ID` and `LARK_DRIVE_SENT_FOLDER_TOKEN` are **optional** env vars. In cloud mode, if a
drive's sent folder is not configured, that drive is **skipped for archiving** with a one-line note — an
existing cloud setup keeps working (sends still go out; only the new archive is skipped) until the folder
is provisioned. `drive:init` provisions the Google `sent/` folder alongside review/approved and prints the
id; the Lark folder is created by hand and its token set in `.env`, exactly as review/approved already are.

### 6. Document format and filename

Document (`renderSent`):

```md
# <itemId> · <channel> (<type>)

- sent: <sentAt>
- postId: <postId>
- url: <url or "—">

---

<the final 공지 text that was sent>
```

Filename (`sentFileName`): **`<sentDate>-<safeItemId>-<channel>.md`** (e.g.
`2026-07-28-x-2080608995371597892-telegram.md`). `sentDate` = `sentAt.slice(0,10)`; `safeItemId` =
`itemId.replace(/[^a-zA-Z0-9._-]/g, "-")`. No source-text slug: at send time only the Korean rendering is
in hand, and slugifying Korean yields an empty slug — the id + channel + date already locate the file, and
avoiding a slug keeps the archiver from having to read the translation store (no cross-store dependency).

## Architecture

- **Domain** `src/domain/publish/publishModels.ts` — `FolderKind` gains `"sent"`.
- **Domain** `src/domain/publish/renderers.ts` — new `renderSent(entry)` and `sentFileName(entry)`. The
  entry shape is the sent-archive record (below); render is pure string-building, like `renderReview`/
  `publishFileName`.
- **Domain** `src/domain/send/channels.ts` (or alongside the send types) — `SentArchiveEntry`:
  `{ itemId: string; type: ConversionType; channel: SendableChannel; text: string; postId: string; url?: string; sentAt: string }`
  and `type Archiver = (entry: SentArchiveEntry) => Promise<void>`.
- **App** `src/app/SendChannels.ts` — constructor gains an optional `archive?: Archiver` (after `record`).
  After a successful `sender.send` + `ledger.add` (+ `record`), it calls `archive(entry)` in its own
  try/catch, warning on failure. Nothing about the send/skip/fail counts changes.
- **Adapters** `src/adapters/drive/GoogleDriveUploader.ts`, `LarkDriveUploader.ts` — `folders` type →
  `Partial<Record<FolderKind, string>>` with an undefined-folder guard in `upload`/`update`.
  `LocalFileUploader` needs no change.
- **CLI** `src/cli/archiver.ts` (new, mirrors `src/cli/recorder.ts`) — `buildArchiver(): Promise<Archiver | undefined>`:
  reads the storage mode; local → one `LocalFileUploader(paths.publishLocalDir)`; cloud → Google and/or
  Lark uploaders, each built **only when its sent folder id is configured** (else warn + skip). Returns
  `undefined` when no target is available (SendChannels then simply has no archiver). The returned
  Archiver builds `name = sentFileName(entry)`, `content = renderSent(entry)`, and calls
  `upload({ name, content, folder: "sent" })` on each uploader, catching per-uploader errors with a warning.
- **CLI** `src/cli/send-channels.ts` — one line: `const archive = await buildArchiver();` passed into
  `new SendChannels(store, senders, ledger, record, archive)`.
- **Config** `src/config.ts` — `loadGoogleDriveConfig` returns optional `sentFolderId`
  (`GDRIVE_SENT_FOLDER_ID`); `loadLarkDriveConfig` returns optional `sentFolderToken`
  (`LARK_DRIVE_SENT_FOLDER_TOKEN`).
- **CLI** `src/cli/drive-init.ts` — also provision a Google `sent/` folder (same parent as review/approved)
  and print `GDRIVE_SENT_FOLDER_ID`.
- **Docs / env** — `.env.example` gains the two vars; `docs/ko` (team-runbook / capabilities / setup) note
  the `sent/` folder and that it is the 2차 완성본 archive.

### Data flow

```
send:channels
  buildArchiver() → Archiver | undefined            # mode-appropriate sent-uploaders
  SendChannels.run: for each approved sendable rendering not already sent:
      sender.send(...) → { postId, url }            # the real, irreversible send
      ledger.add(...)                                # best-effort (existing)
      record(...)  (Sheet history)                   # best-effort (existing)
      archive({ itemId, type, channel, text, postId, url, sentAt })   # best-effort (NEW)
         → for each sent-uploader: upload({ name: sentFileName, content: renderSent, folder: "sent" })
```

## Error handling / edge cases

- **Archive throws** → caught in `SendChannels`, warned, send still counts as `sent`. Never re-sends.
- **A single drive fails** (cloud, one of Google/Lark) → per-uploader try/catch in the Archiver warns and
  moves on; the other drive still archives.
- **Cloud, sent folder not configured** → that drive is skipped at `buildArchiver` time with a note; if
  neither is configured, `buildArchiver` returns `undefined` and no archiving happens.
- **Unsafe filename** → `LocalFileUploader` already refuses names containing `/`, `\`, `..`; `sentFileName`
  never produces those (id is sanitized, channel is an enum, date is ISO).
- **Idempotency** → the archive only runs on an actual send. A re-run of `send:channels` skips
  already-sent renderings (the ledger), so it re-archives nothing — no duplicate documents. A manually
  deleted archive doc is **not** recreated on re-run (it is a point-in-time record, not a synced mirror).
- **Overlimit / failed send** → these paths never reach the archive call (it is inside the success branch,
  after `sender.send` resolves and the ledger row is written).

## Testing

- `renderSent`: exact document string for an entry with a url and one without (`url` → `—`). Pin the text.
- `sentFileName`: `x:2080608995371597892` + `telegram` + `2026-07-28T01:34:42Z` →
  `2026-07-28-x-2080608995371597892-telegram.md`. Pin it; assert the id sanitization (`:` → `-`).
- `SendChannels` with a stub archiver:
  - a successful send calls `archive` exactly once with the right entry (itemId/type/channel/text/postId/
    url/sentAt);
  - an **already-sent** (skipped) and a **failed** send do **not** call `archive`;
  - an archiver that **throws** still leaves the send counted as `sent` (best-effort), and does not throw
    out of `run`.
- `buildArchiver`: local mode → a single local uploader; cloud mode with both sent folders configured →
  google + lark; cloud mode with neither → `undefined`; cloud with only one → that one.
- Drive uploaders: `upload`/`update` with an unconfigured `folder` throw the clear guard error;
  `folder:"sent"` with the sent id maps to the right parent. `LocalFileUploader` writes `folder:"sent"` to
  `<root>/sent/`.
- All tests use synthetic strings; no real post text, tokens, or folder ids; no live network.

## Non-goals

- **Archiving non-sent renderings** (2차-approved-but-unsent, kakao, pr_mail) — the trigger is the send.
- **A sync ledger for the archive** (like publish's `state.json`) — the send ledger already prevents
  re-sends, so the archive can't duplicate; no separate idempotency store is needed.
- **Backfilling** already-sent items from `channels.json` — the feature starts recording from the next
  send onward. (A one-off backfill can be a later slice.)
- **Updating/replacing an archived doc** when a rendering changes after send — an archive is the
  point-in-time record of what went out, not a live mirror.
- **A source-text slug in the filename** — decided against (no cross-store read at send time).

## Global constraints

- Runtime deps stay **zod-only**; no new dependency.
- The send is authoritative: archiving is **best-effort** and can never fail, block, or alter a send.
- Mode symmetry: local → `output/publish/local/sent/`, cloud → Drive `sent/` on Google + Lark.
- Non-breaking: sent folder ids are optional; an existing cloud setup keeps sending, only skipping the new
  archive until the folder is provisioned.
- Public repo: tests use synthetic English/Korean strings only; no real post text, tokens, or folder ids.
- Every test can fail: pin exact document text, filenames, and call counts.

## Open items to verify (not blockers to planning)

- Confirm `drive:init`'s existing Google folder-provisioning helper can create the `sent/` folder under the
  same parent with the same sharing, so no new provisioning code path is introduced.
- Confirm the `SentArchiveEntry` type placement (`domain/send/channels.ts`) does not create an import cycle
  with `domain/publish/renderers.ts`; if it does, put the entry shape in `domain/publish` and have the send
  layer import it.
