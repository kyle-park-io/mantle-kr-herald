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
      {/* `px-5` matches the shell's one phone-width left rail (see `TranslationDetail.tsx`'s own
          comment on its own `px-5`) — this drawer used to start its filter tabs and search box 8px
          further in (`px-3`) than everything else on the phone. `tablet:px-3` keeps today's value
          at 48rem+, where this same `aside` is the static desktop sidebar rather than a drawer. */}
      <div className="sticky top-0 z-10 space-y-2 border-b border-line bg-surface/90 px-5 tablet:px-3 py-2.5 backdrop-blur">
        <div className="inline-flex w-full rounded-lg border border-line bg-bg p-0.5">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              // ~26px before this — already clears WCAG 2.2 SC 2.5.8's 24×24 floor, which is why an
              // earlier pass left it. Reopened because the drawer this sits in is now the phone's
              // primary list surface, not a secondary one. `pointer-coarse:` only grows it for a
              // finger — a mouse in a narrowed desktop window sees the same 4-way segmented control
              // at the same density as before, since the whole row (`align-items: stretch` by
              // default) grows to match whichever tab's `min-h` applies.
              className={`flex-1 inline-flex items-center justify-center whitespace-nowrap rounded-[7px] px-2 py-1 text-[12px] font-medium transition-colors pointer-coarse:min-h-11 ${
                filter === f ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {/* Same trap `App.tsx` documents on 수집134: this button became `inline-flex` for
                  `pointer-coarse:min-h-11` to size it, and a whitespace-only text run between two
                  JSX elements is not rendered as an anonymous flex item — so the space between
                  `{label}` and the count span was dropping (전체12, not 전체 12). The literal space
                  in `{label} <span>` below stays — it is what keeps the accessible name "전체 3",
                  not "전체3" — but since that text run still renders as zero-width once this wrapper
                  is itself a flex container, `gap-[3.34px]` supplies the visible space instead.
                  `gap-[3.34px]` rather than a step on the spacing scale: that is the measured width
                  of the space it replaces at this button's own `text-[12px]`, not just "some" gap. */}
              <span className="flex items-center gap-[3.34px]">
                {label} <span className="font-mono text-[11px] tabular-nums text-faint">{count(f)}</span>
              </span>
            </button>
          ))}
        </div>
        <SearchBox value={search} onChange={setSearch} />
      </div>

      {shown.length === 0 ? (
        <p className="px-5 tablet:px-4 py-6 text-[13px] text-faint">해당하는 항목이 없습니다.</p>
      ) : (
        <ul className="flex-1">
          {shown.map((t) => {
            const active = t.itemId === props.selectedId;
            return (
              <li key={t.itemId}>
                <button
                  onClick={() => props.onSelect(t.itemId)}
                  className={`flex w-full flex-col gap-1.5 border-b border-line px-5 tablet:px-4 py-3 text-left transition-colors ${
                    active ? "bg-mint-soft/60 shadow-[inset_2px_0_0_var(--color-mint)]" : "hover:bg-bg"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {/* Dropping the id on phone (below) left this line with nothing on its left —
                        badges floating alone, right-aligned, above a ragged blank run. The
                        `[YYMMDD]` prefix moves up from the preview line to fill that spot: it is
                        the thing a reviewer's eye already goes to first, so promoting it costs
                        nothing new to read. `tablet:hidden` here / `tablet:inline` on the copy
                        still in the preview paragraph below swap the two back at 48rem+, where the
                        id (still `tablet:inline`) is the row's left anchor and the date stays where
                        it always sat, inline with the preview text. Absent for a `lark:` item (no
                        joined source item, so no `sourcePostedAt`) — the badges' `ml-auto` is then
                        conditional too, so they sit flush left instead of floating right of a blank
                        run in that case as well. */}
                    {t.sourcePostedAt && (
                      <span className="font-mono text-[11px] text-faint tablet:hidden">{datePrefix(t.sourcePostedAt)}</span>
                    )}
                    {/* `x:2081711456320655933` is 20 characters of grey monospace nobody reads on a
                        phone — it identifies nothing to a human, and this row already leads with
                        one line down: the `[YYMMDD]` prefix (now on this line, see above) +
                        Korean preview below. Dropped entirely at phone width rather than
                        shortened, the same call `TranslationDetail.tsx` already made for its own
                        copy of this id (see its comment by the `원문` link) — a shortened id is
                        still unreadable, and the full id is only ever needed "at a desk", where
                        `tablet:` restores it. */}
                    <code className="hidden truncate font-mono text-[11px] text-faint tablet:inline">{t.itemId}</code>
                    <span className={`flex items-center gap-1.5 tablet:ml-auto ${t.sourcePostedAt ? "ml-auto" : ""}`}>
                      <KindBadge kind={t.kind} />
                      <StatusChip status={t.status} />
                    </span>
                  </div>
                  <p className="line-clamp-2 text-[13px] leading-snug text-ink/90">
                    {t.sourcePostedAt && (
                      <span className="mr-1 hidden font-mono text-faint tablet:inline">{datePrefix(t.sourcePostedAt)}</span>
                    )}
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
