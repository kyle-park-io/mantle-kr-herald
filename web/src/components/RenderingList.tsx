import { useState } from "react";
import { ALL_CHANNELS, ALL_TYPES, CHANNEL_LABEL, TYPE_LABEL, datePrefix, type Rendering } from "../types";
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
  kind?: "post" | "article";
  /**
   * One entry per card on the board — `(type, channel)`, in board order, with its own approval.
   *
   * Types alone were misleading: `공지` covers both the telegram card and the kakao one, so
   * approving 오픈카톡 changed nothing visible here and the row looked stuck. A reviewer reads this
   * list to answer "what is left", and what is left is per card.
   */
  groups: { type: Rendering["type"]; channel: Rendering["channel"]; approved: boolean }[];
  approved: number;
  total: number;
  preview: string;
}

const rank = <T,>(order: readonly T[], v: T) => {
  const i = order.indexOf(v);
  return i === -1 ? order.length : i;
};

/** Group renderings by item, ordered by (type, channel) so the preview and badges are stable. */
export function toItemRows(renderings: Rendering[]): ItemRow[] {
  const byItem = new Map<string, Rendering[]>();
  for (const r of renderings) {
    const list = byItem.get(r.itemId);
    if (list) list.push(r);
    else byItem.set(r.itemId, [r]);
  }
  return [...byItem.entries()].map(([itemId, rows]) => {
    const ordered = [...rows].sort(
      (a, b) => rank(ALL_TYPES, a.type) - rank(ALL_TYPES, b.type) || rank(ALL_CHANNELS, a.channel) - rank(ALL_CHANNELS, b.channel),
    );
    return {
      itemId,
      postedAt: ordered.find((r) => r.postedAt)?.postedAt,
      kind: ordered.find((r) => r.kind)?.kind,
      groups: ordered.map((r) => ({ type: r.type, channel: r.channel, approved: r.status === "approved" })),
      approved: ordered.filter((r) => r.status === "approved").length,
      total: ordered.length,
      preview: (ordered[0]?.text ?? "").replace(/\s+/g, " ").trim(),
    };
  });
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

  // Filters still read per rendering — "items that have an approved 공지 for telegram" — but they
  // now decide which *items* are listed, because that is what the row stands for.
  const matching = props.items.filter(
    (r) =>
      (status === "all" || r.status === status) &&
      (channel === "all" || r.channel === channel) &&
      (type === "all" || r.type === type),
  );
  const shown = toItemRows(matching);

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 space-y-2 border-b border-line bg-surface/90 px-3 py-2.5 backdrop-blur">
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
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-faint">해당하는 항목이 없습니다.</p>
      ) : (
        <ul className="flex-1">
          {shown.map((row) => {
            const active = row.itemId === props.selectedId;
            const allApproved = row.approved === row.total;
            return (
              <li key={row.itemId}>
                <button
                  onClick={() => props.onSelect(row.itemId)}
                  className={`flex w-full flex-col gap-1.5 border-b border-line px-4 py-3 text-left transition-colors ${
                    active ? "bg-mint-soft/60 shadow-[inset_2px_0_0_var(--color-mint)]" : "hover:bg-bg"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <code className="truncate font-mono text-[11px] text-faint">{row.itemId}</code>
                    <span className="ml-auto flex items-center gap-1.5">
                      <KindBadge kind={row.kind} />
                      {/* The count only when it says something: `승인 2/3` is the state a reviewer
                          has to come back to, and a bare 대기 chip would hide it. */}
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium ${
                          allApproved ? "bg-mint-soft text-mint" : "bg-amber-soft text-amber-ink"
                        }`}
                        title={`채널 문구 ${row.total}건 중 ${row.approved}건 승인`}
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
                      <span
                        key={`${g.type}:${g.channel}`}
                        className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                          g.approved ? "border-mint/30 bg-mint-soft text-mint" : "border-line text-muted"
                        }`}
                        title={g.approved ? "승인됨" : "검수 대기"}
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
