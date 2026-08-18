import { useEffect, useState } from "react";
import { datePrefix, itemUrl, kstStamp, kstStampCompact } from "../types";
import type { Translation, PublishStateRow } from "../types";
import { StatusChip, KindBadge } from "./TranslationList";
import { Tip } from "./ConfirmDialog";
import { ApprovedButton } from "./ApprovedButton";
import { MarkerText, MediaEditNoticeSlot } from "./MarkerText";
import { diffPublished } from "../publishedDiff";
import { badge, btn, btnApprove } from "../buttonStyles";

const TARGET_LABEL: Record<"local" | "google" | "lark", string> = {
  local: "로컬 폴더",
  google: "Google Drive",
  lark: "Lark Drive",
};

const TARGET_RANK: Record<string, number> = { local: 0, google: 1, lark: 2 };

/** Why a `posted` item's editor and 승인 are locked — "lock, do not hide": the text is still shown,
 *  read-only, and 되돌리기 is the way back. */
const POSTED_LOCK = "이미 X에 직접 게시된 것으로 확인되어 편집할 수 없습니다. 되돌리기를 누르면 다시 검수할 수 있습니다.";

/**
 * The copy the account actually published, under the draft it came from, with the human's edits
 * highlighted.
 *
 * Only for a `posted` item, and only once `x:reconcile` has captured one — see `Translation`'s own
 * `publishedText` comment for why a posted item may legitimately not have it yet. Rendered as text,
 * never an editor: this is a record of what went out, and nothing on this screen may imply it can
 * be changed from here.
 *
 * The highlighting is the point, not decoration. In the case that motivated this block, the entire
 * difference was `구매하신 → 구매한` and `무엇입니까 → 무엇인가요` — a register the team chooses
 * deliberately and the steering config forbids. Two paragraphs side by side hide that; a
 * highlight does not. When a copy is rewritten wholesale the highlight is dropped for a note, since
 * an end-to-end wash of colour carries no information (see `diffPublished`).
 */
function PublishedCopy({ item, posted }: { item: Translation; posted: boolean }) {
  if (!posted || !item.publishedText) return null;
  const diff = diffPublished(item.koreanText, item.publishedText);
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <span className="eyebrow">실제 게시된 글 · published</span>
        {!diff.tooDifferent && (
          <span className="text-[11px] text-faint">칠해진 부분이 사람이 고친 대목입니다</span>
        )}
      </div>
      <div
        data-testid="published-copy"
        className="rounded-xl border border-line bg-bg p-4 text-[15px] leading-relaxed whitespace-pre-wrap text-ink/80 shadow-sm"
      >
        {diff.tooDifferent
          ? item.publishedText
          : diff.parts.map((part, i) => (
              <span
                key={i}
                data-changed={part.changed || undefined}
                className={part.changed ? "rounded bg-amber-ink/15 px-0.5 text-ink" : undefined}
              >
                {part.text}
              </span>
            ))}
      </div>
      {diff.tooDifferent && (
        <div className="mt-1.5 text-[11px] text-faint">
          초안과 견줘 거의 새로 쓰였습니다 — 바뀐 대목을 칠하면 글 전체가 칠해져서, 칠하지 않고 그대로 보여줍니다.
        </div>
      )}
    </section>
  );
}

/**
 * An "open" link that is only active when the row is synced. A "재발행 필요" row's files are the
 * outdated version, so opening them is disabled (greyed) to avoid the review-doc-looks-current
 * confusion — republish first, then the link activates.
 */
function OpenLink({ href, active, children }: { href: string; active: boolean; children: string }) {
  if (!active) {
    return (
      <Tip text="발행을 다시 눌러야 열 수 있어요">
        <span className="cursor-not-allowed text-faint">{children}</span>
      </Tip>
    );
  }
  return (
    <a className="text-mint underline-offset-2 hover:underline" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function TranslationDetail(props: {
  item: Translation;
  publishRows: PublishStateRow[];
  availableTargets: ("local" | "google" | "lark")[];
  onSave: (id: string, koreanText: string) => Promise<void>;
  onApprove: (id: string) => Promise<void>;
  onUnapprove: (id: string) => Promise<void>;
  /**
   * 되돌리기 — disputes a reconcile match: `posted` → `translated`, with `postedUrl`/`postedAt`/
   * `publishedText` left on the row (the server preserves them; see `SaveTranslation.run`'s own
   * comment). That is what stops the next unattended `x:reconcile` tick from re-retiring the same
   * item.
   */
  onUnretire: (id: string) => Promise<void>;
  /**
   * 게시됨으로 — withdraws the dispute `onUnretire` filed, putting the item back on `posted` from the
   * `postedUrl`/`postedAt` still on its row. Offered only where that record exists, so it can never
   * assert a post that never happened. Any edit made since the dispute is kept: `publishedText`
   * holds the copy that actually went out and this pane diffs the two, so the divergence is shown.
   */
  onRetire: (id: string) => Promise<void>;
  onPublish: (id: string, target: string) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { onDirtyChange } = props;
  const [korean, setKorean] = useState(props.item.koreanText);
  const [busy, setBusy] = useState(false);
  useEffect(() => setKorean(props.item.koreanText), [props.item.itemId, props.item.koreanText]);

  const dirty = korean !== props.item.koreanText;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const url = itemUrl(props.item.itemId);
  const approved = props.item.status === "approved";
  const posted = props.item.status === "posted";
  // A published row is out of date (status changed since upload, or content edited) — the server
  // computes this against the current render. Flag it so "파일 열기" showing the old doc isn't confusing.
  //
  // Never for a `posted` item. The server is the source of truth here and already reports a retired
  // item's rows as synced (`createDeps.loadPublishState`), so this is not a second spelling of that
  // rule — it covers the window where the two halves of this view disagree. `App.tsx` fetches
  // `publishState` and `translations` as separate requests, so a retire landing between them leaves
  // a fresh `posted` item beside a stale `synced: false` row, and the notice this drives ("발행을 다시
  // 눌러 갱신하세요") points at 발행 buttons that are now disabled — an instruction the reviewer
  // cannot follow, for an item where following it would have deleted the approved Drive doc.
  const stalePublish = !posted && props.publishRows.some((r) => r.synced === false);

  return (
    // `px-5`(20px) — the shell's one phone-width left rail. The header, the drawer's own header,
    // its filter tabs, its search box and its list rows all start at this same x now
    // (`App.tsx`'s header row, `ListDetailShell.tsx`, `TranslationList.tsx`/`RenderingList.tsx`);
    // this pane used to sit 4px further in (`p-6`, 24px) than the header above it, which is the
    // "edge moves twice" a reviewer's eye catches scanning top to bottom. Vertical padding is
    // untouched — only the horizontal side had a rail to join. `tablet:` keeps today's `p-8`
    // exactly, on both axes: the two-pane desktop layout is not in scope here.
    <div className="mx-auto max-w-3xl px-5 py-6 tablet:px-8 tablet:py-8">
      <div className="mb-6 flex flex-wrap items-center gap-2.5">
        {/* Identity: source date, id (or 원문 link), source badge, kind badge. Never the group that
            breaks — see the state group below for why the split sits here and not wherever each
            item's text happens to run out of room. */}
        <div className="flex flex-wrap items-center gap-2.5">
          {props.item.sourcePostedAt && (
            <span className="font-mono text-[13px] font-medium text-faint">{datePrefix(props.item.sourcePostedAt)}</span>
          )}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[13px] text-muted underline-offset-2 hover:text-mint hover:underline"
            >
              {/* `x:2081711456320655644` is ~150px of a 342px phone line for an id nobody reads —
                  operators copy it into CLI commands, but only at a desk. `tablet:` brings the full
                  id back for exactly that use. The href/target/rel above are untouched either way. */}
              <span className="tablet:hidden">원문 ↗</span>
              <span className="hidden tablet:inline">{props.item.itemId}</span>
            </a>
          ) : (
            // No `postedUrl` to shorten to (a `lark:` item has none), so there is nothing to send
            // the reader to — dropping the `↗` here rather than promising a tap that goes nowhere.
            // The id itself is still noise on a phone for the same reason as the link case, so it
            // gets the same tablet-only treatment.
            <code className="font-mono text-[13px] text-muted">
              <span className="tablet:hidden">원문</span>
              <span className="hidden tablet:inline">{props.item.itemId}</span>
            </code>
          )}
          <span className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-faint uppercase">
            {props.item.source}
          </span>
          <KindBadge kind={props.item.kind} />
        </div>

        {/* State: status chip, plus (posted-only) the live-post link and when it went out. At 390
            these two groups' natural widths (~308px/~340px against a 342px content width) do not
            both fit on one line no matter how short either group's text is, so `w-full` forces this
            one onto its own line rather than letting `flex-wrap` pick the break by content — the
            same technique the header's `<nav>` uses (`App.tsx`). `tablet:w-auto` resets it to a
            content-sized item, restoring the single line this row has always had at 48rem+. */}
        <div className="flex w-full flex-wrap items-center gap-2.5 tablet:w-auto">
          <StatusChip status={props.item.status} />
          {/* The reviewer's own read on what actually went out — "lock, do not hide": the Korean text
              below is locked read-only for a posted item, but the live post itself must stay one click
              away, not merely asserted by the chip above. */}
          {posted && props.item.postedUrl && (
            <>
              <a
                href={props.item.postedUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] font-medium text-slate-ink underline-offset-2 hover:underline"
              >
                게시된 글 보기 ↗
              </a>
              {/* When it went out, beside the link to it. A reviewer's first question about a row they
                  did not approve is "when did this happen?", and the answer is one field away.

                  Labelled, because this header carries TWO dates: the `[YYMMDD]` prefix at the far
                  left is the *English source* post's date, and this is when our Korean copy actually
                  went out on X. Unlabelled they read as the same kind of thing, and the gap between
                  them — how long the item sat in review — is the very thing worth noticing. Only the
                  rendered stamp shrinks on phone (`kstStampCompact` drops the year and ` KST`); the
                  comparison itself, and the label naming it, do not. */}
              {kstStamp(props.item.postedAt) && (
                <span className="text-[12px] text-faint">
                  <span className="tablet:hidden">게시 시각 {kstStampCompact(props.item.postedAt)}</span>
                  <span className="hidden tablet:inline">게시 시각 {kstStamp(props.item.postedAt)}</span>
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/*
        `postedUrl` surviving a 되돌리기 is the whole mechanism that stops the next unattended
        `x:reconcile` tick from re-retiring the same item (see `RetireTranslation`'s own doc
        comment) — but a silent survival would make the undo look like it lost information. This is
        the note that says otherwise: the item reads and acts like any other `translated`/`approved`
        row, plus a pointer to the match a human already disputed.
      */}
      {!posted && props.item.postedUrl && (
        // `<div>`, not `<p>`: `Tip` below can render a `<div>` panel (through `InfoPopover`) once
        // opened, and a `<div>` nested inside a `<p>` is invalid HTML — a real browser splits the `<p>`
        // in two right at that point, which broke this row's flex layout (`validateDOMNesting` catches
        // it in jsdom too). Nothing here relies on `<p>`'s semantics; this was always a flex notice bar.
        <div className="mb-6 flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-soft px-3 py-2 text-[12px] text-slate-ink">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-ink" />
          되돌리기 전 게시됨으로 연결됐던 글이 있습니다 —{" "}
          <a
            href={props.item.postedUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            게시된 글 보기 ↗
          </a>
          {kstStamp(props.item.postedAt) && (
            <span className="text-slate-ink/70">게시 시각 {kstStamp(props.item.postedAt)}</span>
          )}
          {/* Withdraws the dispute. It belongs in this note rather than in the action row below
              because it is about the *record* the note describes, not about this draft's review —
              and because the note is the only place the reviewer can see what they would be
              re-asserting. Not shown when the item is already `posted`: 되돌리기 is the control
              there, and two buttons naming the same axis in opposite directions would read as a
              toggle the rest of this pane deliberately avoids. */}
          <Tip
            text="이 항목을 다시 게시됨으로 표시합니다. 지금 초안이 실제 게시본과 다르면, 1차 검수에 그 차이가 표시됩니다."
            className="ml-auto"
          >
            <button
              className="rounded-md border border-slate-ink/25 bg-surface px-2.5 py-1 text-[12px] font-medium text-slate-ink transition-colors pointer-coarse:min-h-11 hover:bg-slate-soft disabled:opacity-40"
              disabled={busy}
              onClick={() => run(() => props.onRetire(props.item.itemId))}
            >
              게시됨으로
            </button>
          </Tip>
        </div>
      )}

      <section className="mb-6">
        <div className="eyebrow mb-2">원문 · source</div>
        {/*
          No `@container` here. The spec had `MarkerText` branch its preview popover-vs-inline on
          this pane's width, which would have made this the queried container — the implementation
          made the preview unconditionally inline instead (see `MarkerText.tsx`'s own comment), so
          nothing inside this box carries an `@`-variant class to resolve against it. A container
          with nothing querying it is not inert (`container-type: inline-size` still brings layout
          containment), so it was removed rather than left as documentation of an intent nobody
          reads code for.
        */}
        <div className="rounded-xl border border-line bg-surface p-4 text-[15px] leading-relaxed whitespace-pre-wrap text-ink/80 shadow-sm">
          <MarkerText text={props.item.sourceText} />
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <span className="eyebrow">한글 · korean</span>
          {/* Always in layout (invisible when clean) so the textarea doesn't jump when editing starts. */}
          <span
            className={`inline-flex items-center gap-1 text-[11px] font-medium text-amber-ink ${dirty ? "" : "invisible"}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-ink" />
            편집 중
          </span>
        </div>
        <textarea
          className={`min-h-64 w-full resize-y rounded-xl border border-line p-4 text-[15px] leading-relaxed shadow-sm outline-none transition-colors ${
            approved || posted
              ? "bg-bg text-muted"
              : "bg-surface text-ink focus:border-mint focus:ring-4 focus:ring-mint/10"
          }`}
          value={korean}
          onChange={(e) => setKorean(e.target.value)}
          readOnly={approved || posted}
          spellCheck={false}
        />
        {/* Same problem the "편집 중" chip above solves, and the same fix — see `MediaEditNoticeSlot`. */}
        <MediaEditNoticeSlot text={korean} where="원문" className="mt-1.5" />
        {/* `POSTED_LOCK` used to ride this textarea's own `title` — invisible on touch. "Lock, do not
            hide" means the reason a reviewer cannot edit belongs where they are already looking, not
            behind a hover they may never trigger — so it is inline text now, not a tooltip. */}
        {posted && <p className="mt-1.5 text-[12px] leading-relaxed text-faint">{POSTED_LOCK}</p>}
        {/* Fix round 1: this used to be the enabled-only half of 저장's `title` below, but nothing
            about it is enabled-only — it appears nowhere else in the UI, and a reviewer who has not
            typed anything yet (저장's *default* disabled state) still benefits from knowing 저장 alone
            never touches Drive/local files. Inline and unconditional-on-`dirty` beats a `Tip` tied to
            저장's disabled branch, which would lose this the moment there is something to save — the
            one time a reviewer is about to actually press it. */}
        {!posted && !approved && (
          <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
            Drive/로컬 파일은 오른쪽 발행 버튼을 눌러야 갱신됩니다.
          </p>
        )}
      </section>

      <PublishedCopy item={props.item} posted={posted} />

      {/* `mt-6`(24px) — every top-level break in this pane reads the same now: identity/state row
          → 원문 (24, that section's own `mb-6`), 원문 → 한글 (24, ditto), and now 한글's editor →
          this action row (24). It used to be `mt-4`(16px), a smaller value with no stated reason,
          which read as a *closer* relationship to the editor than 원문/한글 have to each other —
          backwards, since "here is what to do with the text" is exactly as big a shift as "here is
          the next thing to read." `발행 상태` below stays at its own larger `mt-8`/`pt-5`: that one
          also crosses a `border-t` divider, which earns the extra room this row does not have. */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {/* `posted`/`approved` are both in 저장's `disabled` expression, so they only ever reach a
            reviewer through `Tip` — a `title` conditioned on either never renders. The Drive/local
            reminder that used to share this button's `title` moved to the always-visible paragraph
            above instead (see its comment): unlike these two lock reasons, it is not about why 저장 is
            disabled, and tying it to 저장's `Tip` would hide it in exactly the state — draft dirty,
            about to save — where it is most worth reading. */}
        <Tip text={posted ? POSTED_LOCK : approved ? "승인 상태에서는 편집할 수 없습니다. 먼저 승인을 취소하세요." : undefined}>
          <button
            className={btn}
            disabled={busy || !dirty || approved || posted}
            onClick={() => run(() => props.onSave(props.item.itemId, korean))}
          >
            저장
          </button>
        </Tip>
        {posted ? (
          <>
            {/* Not a button — 게시됨 is a fact about this item, not a toggle a click could undo the
                way 승인 취소 undoes approval. 되돌리기 below is the actual (distinct, deliberate)
                undo. No `title` here either: it used to repeat `POSTED_LOCK` verbatim, which is now
                permanently visible as inline text beside the textarea above (Task 10) whenever
                `posted` is true — exactly the condition this badge renders under, so a second copy
                would only be noise. */}
            <span className={`${badge} inline-flex min-w-[5.5rem] items-center justify-center bg-slate-soft text-slate-ink`}>
              게시됨 ✓
            </span>
            <Tip text="게시 처리를 취소하고 검수 대기로 되돌립니다. 게시 기록은 남아 있어 다음 자동 확인이 다시 게시됨으로 표시하지 않습니다.">
              <button className={btn} disabled={busy} onClick={() => run(() => props.onUnretire(props.item.itemId))}>
                되돌리기
              </button>
            </Tip>
          </>
        ) : approved ? (
          <ApprovedButton onUnapprove={() => run(() => props.onUnapprove(props.item.itemId))} disabled={busy} />
        ) : (
          <Tip text={dirty ? "편집 내용을 먼저 저장하세요" : undefined}>
            <button
              className={btnApprove}
              disabled={busy || dirty}
              onClick={() => run(() => props.onApprove(props.item.itemId))}
            >
              승인하기
            </button>
          </Tip>
        )}
      </div>

      {/* Its own row, not appended to the review-action row above: those answer "what to do with
          this translation" (저장/승인/되돌리기) while this answers "where to publish it" — two
          different kinds of action that used to wrap as one blob, landing the boundary between them
          wherever the viewport happened to put it. A row break makes the boundary the same at every
          width, so the old inline divider (`mx-1 h-5 w-px bg-line`) that separated them within one
          line is gone — there is no longer an adjacent element on the same line for it to separate. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-faint">발행</span>
        {(["local", "google", "lark"] as const).map((t) => {
          const usable = props.availableTargets.includes(t);
          /**
           * Why this is not a `title` on the button, which is what it used to be: every reason below
           * ALSO forces `disabled`, and a disabled button dispatches no pointer events, so the browser
           * never renders its native tooltip. All three messages were dead — including the one that
           * explains the hosted board's greyed `[로컬 폴더]`, the single thing standing between a
           * reviewer and "why is this button broken". `Tip` carries it on the wrapper instead.
           */
          const blocked = posted
            ? POSTED_LOCK
            : !usable
              ? "이 모드에서는 사용할 수 없는 타깃"
              : dirty
                ? "편집 내용을 먼저 저장하세요"
                : undefined;
          return (
            <Tip key={t} text={blocked}>
              <button
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors pointer-coarse:min-h-11 hover:bg-bg disabled:border-line disabled:bg-bg disabled:text-faint disabled:opacity-60"
                // `posted` disables these for the same reason it disables 저장 and 승인 above: the item
                // is terminal for the Drive path. The server refuses it too (409) — this is the half
                // that stops a reviewer being invited into it in the first place. Leaving them live was
                // the sharp edge: a retired-but-previously-approved item used to read "재발행 필요", and
                // pressing 발행 re-rendered it as a review doc, uploaded it to review/, and deleted the
                // approved doc that recorded the copy actually published.
                disabled={busy || !usable || dirty || posted}
                onClick={() => run(() => props.onPublish(props.item.itemId, t))}
              >
                {TARGET_LABEL[t]}
              </button>
            </Tip>
          );
        })}
      </div>

      {stalePublish && (
        <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-amber-soft px-3 py-2 text-[12px] text-amber-ink">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-ink" />
          발행된 파일이 최신이 아닙니다 (승인 상태 변경 또는 내용 수정) — <span className="font-medium">발행을 다시 눌러</span> 갱신하세요.
        </p>
      )}

      <section className="mt-8 border-t border-line pt-5">
        <div className="eyebrow mb-2.5">발행 상태</div>
        {props.publishRows.length === 0 ? (
          <p className="text-[13px] text-faint">아직 발행되지 않았습니다.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {[...props.publishRows]
              .sort((a, b) => (TARGET_RANK[a.target] ?? 9) - (TARGET_RANK[b.target] ?? 9))
              .map((r) => (
                <li
                  key={`${r.status}:${r.target}`}
                  className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13px]"
                >
                  <span className="font-mono text-[11px] text-faint uppercase">{r.target}</span>
                  {r.synced === true ? (
                    <span className="inline-flex items-center gap-1 text-[12px] text-mint">
                      <span className="h-1.5 w-1.5 rounded-full bg-mint" />
                      발행됨
                    </span>
                  ) : r.synced === false ? (
                    <span className="rounded bg-amber-soft px-1.5 py-0.5 text-[11px] font-medium text-amber-ink">
                      재발행 필요
                    </span>
                  ) : (
                    <span className="text-muted">{r.status}</span>
                  )}
                  <span className="ml-auto flex items-center gap-3">
                    {r.target === "local" ? (
                      r.remoteId ? (
                        <OpenLink
                          active={r.synced === true}
                          href={`/api/publish/local/${r.remoteId.split("/").map(encodeURIComponent).join("/")}`}
                        >
                          파일 열기 ↗
                        </OpenLink>
                      ) : (
                        <span className="text-faint">링크 없음</span>
                      )
                    ) : r.folderUrl || r.fileUrl ? (
                      <>
                        {r.folderUrl && (
                          <OpenLink active={r.synced === true} href={r.folderUrl}>
                            폴더 열기 ↗
                          </OpenLink>
                        )}
                        {r.fileUrl && (
                          <OpenLink active={r.synced === true} href={r.fileUrl}>
                            파일 열기 ↗
                          </OpenLink>
                        )}
                      </>
                    ) : (
                      <span className="text-faint">링크 없음</span>
                    )}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
