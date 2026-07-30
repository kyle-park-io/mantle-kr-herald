import { useEffect, useState } from "react";
import { datePrefix, itemUrl } from "../types";
import type { Translation, PublishStateRow } from "../types";
import { StatusChip, KindBadge } from "./TranslationList";
import { MarkerText, MediaEditNotice } from "./MarkerText";

const TARGET_LABEL: Record<"local" | "google" | "lark", string> = {
  local: "로컬 폴더",
  google: "Google Drive",
  lark: "Lark Drive",
};

const TARGET_RANK: Record<string, number> = { local: 0, google: 1, lark: 2 };

/**
 * An "open" link that is only active when the row is synced. A "재발행 필요" row's files are the
 * outdated version, so opening them is disabled (greyed) to avoid the review-doc-looks-current
 * confusion — republish first, then the link activates.
 */
function OpenLink({ href, active, children }: { href: string; active: boolean; children: string }) {
  if (!active) {
    return (
      <span className="group/tip relative cursor-not-allowed text-faint">
        {children}
        <span className="pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 hidden whitespace-nowrap rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-normal text-muted shadow-md group-hover/tip:block">
          발행을 다시 눌러야 열 수 있어요
        </span>
      </span>
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
  // A published row is out of date (status changed since upload, or content edited) — the server
  // computes this against the current render. Flag it so "파일 열기" showing the old doc isn't confusing.
  const stalePublish = props.publishRows.some((r) => r.synced === false);

  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-8">
      <div className="mb-6 flex flex-wrap items-center gap-2.5">
        {props.item.postedAt && (
          <span className="font-mono text-[13px] font-medium text-faint">{datePrefix(props.item.postedAt)}</span>
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
      </div>

      <section className="mb-6">
        <div className="eyebrow mb-2">원문 · source</div>
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
            approved
              ? "bg-bg text-muted"
              : "bg-surface text-ink focus:border-mint focus:ring-4 focus:ring-mint/10"
          }`}
          value={korean}
          onChange={(e) => setKorean(e.target.value)}
          readOnly={approved}
          spellCheck={false}
        />
        <div className="mt-1.5 grid" data-testid="media-edit-notice-slot">
          {/*
           * Reserves one line at the notice's own type scale so the button row below never moves as a
           * marker starts or stops matching mid-edit — same problem the "편집 중" chip above solves, and
           * the same fix: keep something in layout at all times instead of letting the row collapse to
           * zero height. MediaEditNotice itself still returns null when the text carries no marker (Task
           * 2's contract, and the other screen relies on that), so the strut lives here, not there: an
           * invisible placeholder line shares this grid cell with the real notice (the same
           * same-cell-overlap trick the 승인됨/승인 취소 button labels use above), so the slot is exactly
           * one line tall whether or not anything renders inside it.
           */}
          <p aria-hidden="true" className="invisible col-start-1 row-start-1 text-[12px] leading-relaxed">
            {" "}
          </p>
          <div className="col-start-1 row-start-1">
            <MediaEditNotice text={korean} where="원문" />
          </div>
        </div>
      </section>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          className="rounded-lg border border-line-strong bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-bg disabled:opacity-40"
          disabled={busy || !dirty || approved}
          onClick={() => run(() => props.onSave(props.item.itemId, korean))}
          title={
            approved
              ? "승인 상태에서는 편집할 수 없습니다. 먼저 승인을 취소하세요."
              : "편집한 번역을 저장합니다. Drive/로컬 파일은 오른쪽 발행 버튼을 눌러야 갱신됩니다."
          }
        >
          저장
        </button>
        {approved ? (
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
          <button
            className="inline-flex min-w-[5.5rem] items-center justify-center rounded-lg bg-mint px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-mint-hover disabled:opacity-40"
            disabled={busy || dirty}
            onClick={() => run(() => props.onApprove(props.item.itemId))}
            title={dirty ? "편집 내용을 먼저 저장하세요" : undefined}
          >
            승인하기
          </button>
        )}

        <span className="mx-1 h-5 w-px bg-line" />
        <span className="text-[11px] font-medium text-faint">발행</span>
        {(["local", "google", "lark"] as const).map((t) => {
          const usable = props.availableTargets.includes(t);
          return (
            <button
              key={t}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-bg disabled:border-line disabled:bg-bg disabled:text-faint disabled:opacity-60"
              disabled={busy || !usable || dirty}
              onClick={() => run(() => props.onPublish(props.item.itemId, t))}
              title={!usable ? "이 모드에서는 사용할 수 없는 타깃" : dirty ? "편집 내용을 먼저 저장하세요" : undefined}
            >
              {TARGET_LABEL[t]}
            </button>
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
