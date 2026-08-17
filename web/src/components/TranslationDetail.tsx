import { useEffect, useState } from "react";
import { datePrefix, itemUrl, kstStamp } from "../types";
import type { Translation, PublishStateRow } from "../types";
import { StatusChip, KindBadge } from "./TranslationList";
import { Tip } from "./ConfirmDialog";
import { MarkerText, MediaEditNoticeSlot } from "./MarkerText";
import { diffPublished } from "../publishedDiff";

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
    <div className="mx-auto max-w-3xl p-6 tablet:p-8">
      <div className="mb-6 flex flex-wrap items-center gap-2.5">
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
            {props.item.itemId}
          </a>
        ) : (
          <code className="font-mono text-[13px] text-muted">{props.item.itemId}</code>
        )}
        <span className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-faint uppercase">
          {props.item.source}
        </span>
        <KindBadge kind={props.item.kind} />
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
                them — how long the item sat in review — is the very thing worth noticing. */}
            {kstStamp(props.item.postedAt) && (
              <span className="text-[12px] text-faint">게시 시각 {kstStamp(props.item.postedAt)}</span>
            )}
          </>
        )}
      </div>

      {/*
        `postedUrl` surviving a 되돌리기 is the whole mechanism that stops the next unattended
        `x:reconcile` tick from re-retiring the same item (see `RetireTranslation`'s own doc
        comment) — but a silent survival would make the undo look like it lost information. This is
        the note that says otherwise: the item reads and acts like any other `translated`/`approved`
        row, plus a pointer to the match a human already disputed.
      */}
      {!posted && props.item.postedUrl && (
        <p className="mb-6 flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-soft px-3 py-2 text-[12px] text-slate-ink">
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
          <button
            className="ml-auto rounded-md border border-slate-ink/25 bg-surface px-2.5 py-1 text-[12px] font-medium text-slate-ink transition-colors hover:bg-slate-soft disabled:opacity-40"
            disabled={busy}
            onClick={() => run(() => props.onRetire(props.item.itemId))}
            title="이 항목을 다시 게시됨으로 표시합니다. 지금 초안이 실제 게시본과 다르면, 1차 검수에 그 차이가 표시됩니다."
          >
            게시됨으로
          </button>
        </p>
      )}

      <section className="mb-6">
        <div className="eyebrow mb-2">원문 · source</div>
        <div className="@container rounded-xl border border-line bg-surface p-4 text-[15px] leading-relaxed whitespace-pre-wrap text-ink/80 shadow-sm">
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
          title={posted ? POSTED_LOCK : undefined}
          spellCheck={false}
        />
        {/* Same problem the "편집 중" chip above solves, and the same fix — see `MediaEditNoticeSlot`. */}
        <MediaEditNoticeSlot text={korean} where="원문" className="mt-1.5" />
      </section>

      <PublishedCopy item={props.item} posted={posted} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* Split by whether the message survives its own control: `posted` and `approved` are both in
            the `disabled` expression, so those two only reach a reviewer through `Tip`. The third is
            the ordinary hint on a live 저장 button and stays a `title`. */}
        <Tip
          text={posted ? POSTED_LOCK : approved ? "승인 상태에서는 편집할 수 없습니다. 먼저 승인을 취소하세요." : undefined}
        >
          <button
            className="rounded-lg border border-line-strong bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-bg disabled:opacity-40"
            disabled={busy || !dirty || approved || posted}
            onClick={() => run(() => props.onSave(props.item.itemId, korean))}
            title={
              posted || approved
                ? undefined
                : "편집한 번역을 저장합니다. Drive/로컬 파일은 오른쪽 발행 버튼을 눌러야 갱신됩니다."
            }
          >
            저장
          </button>
        </Tip>
        {posted ? (
          <>
            {/* Not a button — 게시됨 is a fact about this item, not a toggle a click could undo the
                way 승인 취소 undoes approval. 되돌리기 below is the actual (distinct, deliberate)
                undo. */}
            <span
              className="inline-flex min-w-[5.5rem] items-center justify-center rounded-lg bg-slate-soft px-3.5 py-1.5 text-[13px] font-medium text-slate-ink"
              title={POSTED_LOCK}
            >
              게시됨 ✓
            </span>
            <button
              className="rounded-lg border border-line-strong bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-bg disabled:opacity-40"
              disabled={busy}
              onClick={() => run(() => props.onUnretire(props.item.itemId))}
              title="게시 처리를 취소하고 검수 대기로 되돌립니다. 게시 기록은 남아 있어 다음 자동 확인이 다시 게시됨으로 표시하지 않습니다."
            >
              되돌리기
            </button>
          </>
        ) : approved ? (
          <button
            className="group grid min-w-[5.5rem] place-items-center rounded-lg bg-mint-soft px-3.5 py-1.5 text-[13px] font-medium text-mint transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
            disabled={busy}
            onClick={() => run(() => props.onUnapprove(props.item.itemId))}
            title="클릭하면 승인을 취소합니다"
          >
            {/* Both labels share one grid cell, so the button sizes to the wider and never jumps on hover. */}
            <span className="col-start-1 row-start-1 whitespace-nowrap transition-opacity group-hover:opacity-0">
              승인됨 ✓
            </span>
            <span className="col-start-1 row-start-1 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100">
              승인 취소
            </span>
          </button>
        ) : (
          <Tip text={dirty ? "편집 내용을 먼저 저장하세요" : undefined}>
            <button
              className="inline-flex min-w-[5.5rem] items-center justify-center rounded-lg bg-mint px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-mint-hover disabled:opacity-40"
              disabled={busy || dirty}
              onClick={() => run(() => props.onApprove(props.item.itemId))}
            >
              승인하기
            </button>
          </Tip>
        )}

        <span className="mx-1 h-5 w-px bg-line" />
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
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-bg disabled:border-line disabled:bg-bg disabled:text-faint disabled:opacity-60"
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
