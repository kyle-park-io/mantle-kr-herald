import { useState } from "react";
import { compileQuery } from "../hangulSearch";
import { datePrefix, type Translation } from "../types";
import { SearchBox } from "./SearchBox";

type Filter = "all" | "translated" | "approved" | "posted";

/**
 * Labels match the `StatusChip` vocabulary a row over — 대기 · 승인 · 게시됨 — rather than the
 * longer 검수 대기 · 승인됨 they used before the counts arrived. Two reasons, one of them physical:
 * four tabs plus their counts do not fit a `w-80` sidebar at the old widths, and `검수 대기 5` wrapped
 * its count onto a second line, which made that one tab taller than its neighbours. The other is that
 * a tab and the chip it filters for should not name the same status two different ways.
 */
const FILTERS: [Filter, string][] = [
  ["all", "전체"],
  ["translated", "대기"],
  ["approved", "승인"],
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
  const [search, setSearch] = useState("");
  const matches = (t: Translation, f: Filter) => f === "all" || t.status === f;
  /**
   * 검색 대상은 `preview()`가 쓰는 `koreanText || sourceText`가 아니라 **둘 다**이다. 번역이 붙은
   * 뒤에도 영문 원문의 단어로 찾을 수 있어야 하고, 검수자가 기억하는 구절이 어느 쪽 언어일지는
   * 정해져 있지 않다. `itemId`는 링크를 타고 온 id를 그대로 붙여넣는 경로를 위해.
   */
  const re = compileQuery(search);
  const found = re === null ? props.items : props.items.filter((t) => re.test(`${t.itemId} ${t.koreanText} ${t.sourceText}`));
  // Copied before sorting: `props.items` is App's state array, and sorting in place would mutate it.
  const shown = found.filter((t) => matches(t, filter)).slice().sort(newestFirst);
  /**
   * Same predicate as `shown`, so a tab can never promise a row it does not then show.
   *
   * The counts exist because the labels alone made a finished queue look like a full one: once
   * reconcile started retiring hand-published items to `posted`, 전체 could read 23 while 검수 대기
   * held 2, and the only way to learn that was to click. `pnpm status` had the same blind spot on
   * the same data (`src/status/pipeline.ts`).
   *
   * 검색 중에도 같은 계약이다 — `props.items`가 아니라 `found` 위에서 센다. 아니면 `전체 23`이 뜬
   * 채 아래에 두 줄만 보이고, 카운트가 생긴 이유였던 착시가 그대로 돌아온다.
   */
  const count = (f: Filter) => found.filter((t) => matches(t, f)).length;
  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 space-y-2 border-b border-line bg-surface/90 px-3 py-2.5 backdrop-blur">
        <div className="inline-flex w-full rounded-lg border border-line bg-bg p-0.5">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 whitespace-nowrap rounded-[7px] px-2 py-1 text-[12px] font-medium transition-colors ${
                filter === f ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {label} <span className="font-mono text-[11px] tabular-nums text-faint">{count(f)}</span>
            </button>
          ))}
        </div>
        <SearchBox value={search} onChange={setSearch} />
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
