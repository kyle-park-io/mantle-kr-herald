import { useState } from "react";
import { compileQuery } from "../hangulSearch";
import { ALL_CHANNELS, ALL_TYPES, CHANNEL_LABEL, TYPE_LABEL, datePrefix, type Rendering } from "../types";
import { SearchBox } from "./SearchBox";
import { KindBadge } from "./TranslationList";

const STATUS_FILTERS: ["all" | Rendering["status"], string][] = [
  ["all", "전체"],
  ["rendered", "검수 대기"],
  ["approved", "승인됨"],
];

/**
 * One item's renderings, folded into a row. The board opens per *item* and shows every group that
 * item has, so a list keyed by rendering put the same item on screen three times, each opening the
 * identical board — three rows that were never three choices.
 */
interface ItemRow {
  itemId: string;
  postedAt?: string;
  /**
   * The newest `createdAt` among this item's cards — the sort fallback when the source join gave no
   * `postedAt`. The newest and not the first card's: `ordered` is ranked by (type, channel), so the
   * first card is whichever type sorts earliest, not whichever was rendered last, and `pnpm format
   * --only-missing` adds a channel to an item long after the rest of its board was built.
   */
  createdAt: string;
  kind?: "post" | "article";
  /**
   * One entry per card on the board — `(type, channel)`, in board order, with its own approval.
   *
   * Types alone were misleading: back when `공지` covered both the telegram card and the kakao one,
   * approving 오픈카톡 changed nothing visible here and the row looked stuck. The 공지 split gave
   * KakaoTalk its own type, but the shape is unchanged — `--channels` still renders one type to
   * several channels, and the pre-split `(공지, 카카오)` cards are still on the board. A reviewer
   * reads this list to answer "what is left", and what is left is per card.
   */
  groups: { type: Rendering["type"]; channel: Rendering["channel"]; approved: boolean }[];
  approved: number;
  total: number;
  preview: string;
  /**
   * 검색이 훑는 문자열 — itemId와, 상태·채널·타입 셀렉트를 **통과해 살아남은** 카드들의 문구.
   * `toItemRows`는 이미 그 셀렉트들로 좁혀진 `matching` 위에서 불리므로, 필터에 걸러진 카드의
   * 문구는 여기 들어오지 않는다. 그래서 필터는 목록에 뜨는 행만이 아니라 검색이 훑을 수 있는
   * 범위 자체도 좁힌다 — 텔레그램·카카오 카드를 모두 가진 아이템에서 카카오 카드에만 있는
   * 문구로 검색해 행을 찾았어도, 채널을 텔레그램으로 좁히면 그 보드를 열면 여전히 그 문구가
   * 있는데도 행은 사라진다. 의도된 동작이다(검색은 셀렉트 필터와 AND로 걸린다) — 이 주석은 그
   * 사실을 기록할 뿐 바꾸자는 것이 아니다.
   *
   * `preview`는 첫 카드뿐이라, 살아남은 카드 중 다른 카드에만 있는 문구로 검색하면 행은 뜨지만
   * 미리보기에는 그 문구가 안 보일 수 있다. 이것도 감수하는 성질이다: 행의 역할은 보드를 여는
   * 것이지 매치를 증명하는 것이 아니고, 카드마다 행을 나누는 대안은 이 파일 위쪽 `ItemRow`
   * 주석이 이미 기각했다.
   */
  haystack: string;
}

const rank = <T,>(order: readonly T[], v: T) => {
  const i = order.indexOf(v);
  return i === -1 ? order.length : i;
};

/**
 * Newest first, by the date the row actually shows — its `[YYMMDD]` prefix, which is the *source*
 * post's date (`postedAt`), not when the card was rendered. Deliberately the same rule as 1차's
 * `newestFirst` (`TranslationList.tsx`), down to the id tiebreak: the two sidebars sit behind one
 * tab switch and a reviewer carries the reading order across it.
 *
 * Sorted on this screen rather than in the store for the reason 1차 gives: `loadAll()`'s `order by
 * ordinal` is insertion order, a contract `db:export`'s round-trip relies on, so reading order
 * belongs to the screen that does the reading.
 */
const newestFirst = (a: ItemRow, b: ItemRow): number => {
  const at = (row: ItemRow) => row.postedAt ?? row.createdAt;
  return at(b).localeCompare(at(a)) || b.itemId.localeCompare(a.itemId, undefined, { numeric: true });
};

/**
 * Group renderings by item, ordered by (type, channel) so the preview and badges are stable, and the
 * rows themselves newest-first.
 */
export function toItemRows(renderings: Rendering[]): ItemRow[] {
  const byItem = new Map<string, Rendering[]>();
  for (const r of renderings) {
    const list = byItem.get(r.itemId);
    if (list) list.push(r);
    else byItem.set(r.itemId, [r]);
  }
  return [...byItem.entries()]
    .map(([itemId, rows]) => {
      const ordered = [...rows].sort(
        (a, b) => rank(ALL_TYPES, a.type) - rank(ALL_TYPES, b.type) || rank(ALL_CHANNELS, a.channel) - rank(ALL_CHANNELS, b.channel),
      );
      return {
        itemId,
        postedAt: ordered.find((r) => r.postedAt)?.postedAt,
        createdAt: ordered.reduce((newest, r) => (r.createdAt > newest ? r.createdAt : newest), ""),
        kind: ordered.find((r) => r.kind)?.kind,
        groups: ordered.map((r) => ({ type: r.type, channel: r.channel, approved: r.status === "approved" })),
        approved: ordered.filter((r) => r.status === "approved").length,
        total: ordered.length,
        preview: (ordered[0]?.text ?? "").replace(/\s+/g, " ").trim(),
        haystack: [itemId, ...ordered.map((r) => r.text)].join(" "),
      };
    })
    .sort(newestFirst);
}

const selectClass =
  "rounded-lg border border-line bg-surface px-2 py-1 text-[13px] text-ink outline-none focus:border-mint";

export function RenderingList(props: {
  items: Rendering[];
  selectedId: string | null;
  onSelect: (itemId: string) => void;
}) {
  const [status, setStatus] = useState<"all" | Rendering["status"]>("all");
  const [channel, setChannel] = useState<"all" | Rendering["channel"]>("all");
  const [type, setType] = useState<"all" | Rendering["type"]>("all");
  const [search, setSearch] = useState("");

  // Filters still read per rendering — "items that have an approved 공지 for telegram" — but they
  // now decide which *items* are listed, because that is what the row stands for.
  const matching = props.items.filter(
    (r) =>
      (status === "all" || r.status === status) &&
      (channel === "all" || r.channel === channel) &&
      (type === "all" || r.type === type),
  );
  // 검색은 셀렉트 필터가 좁힌 집합 위에서, 아이템 행 단위로 걸린다 — 셋 다 AND다.
  const re = compileQuery(search);
  const rows = toItemRows(matching);
  const shown = re === null ? rows : rows.filter((row) => re.test(row.haystack));

  return (
    <div className="flex h-full flex-col">
      {/* `px-5` matches the shell's one phone-width left rail — see `TranslationList.tsx`'s own
          copy of this comment, which this sidebar mirrors exactly. `tablet:px-3` keeps today's
          value at 48rem+. */}
      <div className="sticky top-0 z-10 space-y-2 border-b border-line bg-surface/90 px-5 tablet:px-3 py-2.5 backdrop-blur">
        <div className="inline-flex w-full rounded-lg border border-line bg-bg p-0.5">
          {STATUS_FILTERS.map(([f, label]) => (
            <button
              key={f}
              onClick={() => setStatus(f)}
              className={`flex-1 rounded-[7px] px-2 py-1 text-[12px] font-medium transition-colors ${
                status === f ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <select className={`${selectClass} flex-1`} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
            <option value="all">모든 채널</option>
            {ALL_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select className={`${selectClass} flex-1`} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="all">모든 타입</option>
            {ALL_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <SearchBox value={search} onChange={setSearch} />
      </div>

      {shown.length === 0 ? (
        <p className="px-5 tablet:px-4 py-6 text-[13px] text-faint">해당하는 항목이 없습니다.</p>
      ) : (
        <ul className="flex-1">
          {shown.map((row) => {
            const active = row.itemId === props.selectedId;
            const allApproved = row.approved === row.total;
            return (
              <li key={row.itemId}>
                <button
                  onClick={() => props.onSelect(row.itemId)}
                  className={`flex w-full flex-col gap-1.5 border-b border-line px-5 tablet:px-4 py-3 text-left transition-colors ${
                    active ? "bg-mint-soft/60 shadow-[inset_2px_0_0_var(--color-mint)]" : "hover:bg-bg"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {/* Dropped entirely at phone width, kept at `tablet:` — same call and same
                        reason as `TranslationList.tsx`'s copy of this row (see its comment). */}
                    <code className="hidden truncate font-mono text-[11px] text-faint tablet:inline">{row.itemId}</code>
                    <span className="ml-auto flex items-center gap-1.5">
                      <KindBadge kind={row.kind} />
                      {/* The count only when it says something: `승인 2/3` is the state a reviewer
                          has to come back to, and a bare 대기 chip would hide it. */}
                      {/* No `title` here (Task 10 removed one): its text — "채널 문구 N건 중 M건
                          승인" — was fully redundant with what the chip already shows: "승인" when
                          `N===M`, or the same two numbers spelled out as "대기 M/N" otherwise. It was
                          also unreachable to promote cleanly — this span sits inside the row's own
                          `<button onSelect>`, and wrapping it in `Tip` would nest a second focusable,
                          click-toggling element inside that button and hijack the row-select click. */}
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium ${
                          allApproved ? "bg-mint-soft text-mint" : "bg-amber-soft text-amber-ink"
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${allApproved ? "bg-mint" : "bg-amber-ink"}`} />
                        {allApproved ? "승인" : `대기 ${row.approved}/${row.total}`}
                      </span>
                    </span>
                  </div>
                  <p className="line-clamp-2 text-[13px] leading-snug text-ink/90">
                    {row.postedAt && <span className="mr-1 font-mono text-faint">{datePrefix(row.postedAt)}</span>}
                    {row.preview}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {row.groups.map((g) => (
                      // No `title` here either, for the same two reasons as the chip above: "승인됨"/
                      // "검수 대기" mostly restates the `✓ ` prefix + colour already on this chip, and
                      // this span too sits inside the row's `<button onSelect>`.
                      <span
                        key={`${g.type}:${g.channel}`}
                        className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                          g.approved ? "border-mint/30 bg-mint-soft text-mint" : "border-line text-muted"
                        }`}
                      >
                        {g.approved && "✓ "}
                        {TYPE_LABEL[g.type]} · {CHANNEL_LABEL[g.channel]}
                      </span>
                    ))}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
