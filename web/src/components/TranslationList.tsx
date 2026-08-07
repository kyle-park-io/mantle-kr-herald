import { useState } from "react";
import { datePrefix, type Translation } from "../types";

type Filter = "all" | "translated" | "approved" | "posted";

const FILTERS: [Filter, string][] = [
  ["all", "전체"],
  ["translated", "검수 대기"],
  ["approved", "승인됨"],
  ["posted", "게시됨"],
];

/**
 * Three colours, one per status: amber (대기, still needs a decision), mint (승인, this reviewer's
 * own approval), and a deliberately neutral slate for `posted` (게시됨) — a translation reconcile
 * already matched against a live @0xMantleKR post, so it reads as "done, not actionable" rather than
 * either of the other two verbs.
 */
export function StatusChip({ status }: { status: Translation["status"] }) {
  if (status === "posted") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-slate-soft px-2 py-0.5 text-[12px] font-medium text-slate-ink">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-ink" />
        게시됨
      </span>
    );
  }
  const approved = status === "approved";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium ${
        approved ? "bg-mint-soft text-mint" : "bg-amber-soft text-amber-ink"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${approved ? "bg-mint" : "bg-amber-ink"}`} />
      {approved ? "승인" : "대기"}
    </span>
  );
}

export function KindBadge({ kind }: { kind?: "post" | "article" }) {
  if (!kind) return null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-md border border-line px-1.5 py-0.5 text-[11px] font-medium text-muted">
      {kind === "article" ? "아티클" : "포스트"}
    </span>
  );
}

const preview = (t: Translation) => (t.koreanText || t.sourceText).replace(/\s+/g, " ").trim();

/**
 * Newest first, by the date the row actually shows — its `[YYMMDD]` prefix, which is the *source*
 * post's date (`sourcePostedAt`), not when we translated it.
 *
 * Sorted here rather than in the store: `loadAll()`'s `order by ordinal` is insertion order, and
 * `PgTranslationStore`'s own doc comment makes that a contract other consumers rely on (`db:export`'s
 * round-trip reproduces it). Reading order is a property of this screen, so it belongs on this screen.
 *
 * `sourcePostedAt` is joined from the source item and can be absent, so `translatedAt` — always
 * present — is the fallback; without it a row missing that join would sink to the bottom as though it
 * were the oldest thing in the queue. The itemId tiebreak keeps two posts sharing a timestamp from
 * swapping places between renders (X ids increase with time, so it also happens to be right).
 */
const newestFirst = (a: Translation, b: Translation): number => {
  const at = (t: Translation) => t.sourcePostedAt ?? t.translatedAt;
  return at(b).localeCompare(at(a)) || b.itemId.localeCompare(a.itemId, undefined, { numeric: true });
};

export function TranslationList(props: {
  items: Translation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  // Copied before sorting: `props.items` is App's state array, and sorting in place would mutate it.
  const shown = props.items.filter((t) => filter === "all" || t.status === filter).slice().sort(newestFirst);
  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-line bg-surface/90 px-3 py-2.5 backdrop-blur">
        <div className="inline-flex w-full rounded-lg border border-line bg-bg p-0.5">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 rounded-[7px] px-2 py-1 text-[12px] font-medium transition-colors ${
                filter === f ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-faint">해당하는 항목이 없습니다.</p>
      ) : (
        <ul className="flex-1">
          {shown.map((t) => {
            const active = t.itemId === props.selectedId;
            return (
              <li key={t.itemId}>
                <button
                  onClick={() => props.onSelect(t.itemId)}
                  className={`flex w-full flex-col gap-1.5 border-b border-line px-4 py-3 text-left transition-colors ${
                    active ? "bg-mint-soft/60 shadow-[inset_2px_0_0_var(--color-mint)]" : "hover:bg-bg"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <code className="truncate font-mono text-[11px] text-faint">{t.itemId}</code>
                    <span className="ml-auto flex items-center gap-1.5">
                      <KindBadge kind={t.kind} />
                      <StatusChip status={t.status} />
                    </span>
                  </div>
                  <p className="line-clamp-2 text-[13px] leading-snug text-ink/90">
                    {t.sourcePostedAt && <span className="mr-1 font-mono text-faint">{datePrefix(t.sourcePostedAt)}</span>}
                    {preview(t)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
