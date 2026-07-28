import { useState } from "react";
import { ALL_CHANNELS, ALL_TYPES, TYPE_LABEL, renderingKey, type Rendering } from "../types";

const STATUS_FILTERS: ["all" | Rendering["status"], string][] = [
  ["all", "전체"],
  ["rendered", "검수 대기"],
  ["approved", "승인됨"],
];

export function RenderingChip({ status }: { status: Rendering["status"] }) {
  const approved = status === "approved";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
        approved ? "bg-mint-soft text-mint" : "bg-amber-soft text-amber-ink"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${approved ? "bg-mint" : "bg-amber-ink"}`} />
      {approved ? "승인" : "대기"}
    </span>
  );
}

const selectClass =
  "rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-mint";

export function RenderingList(props: {
  items: Rendering[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [status, setStatus] = useState<"all" | Rendering["status"]>("all");
  const [channel, setChannel] = useState<"all" | Rendering["channel"]>("all");
  const [type, setType] = useState<"all" | Rendering["type"]>("all");
  const shown = props.items.filter(
    (r) =>
      (status === "all" || r.status === status) &&
      (channel === "all" || r.channel === channel) &&
      (type === "all" || r.type === type),
  );
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
        <p className="px-4 py-6 text-[13px] text-faint">해당하는 렌더링이 없습니다.</p>
      ) : (
        <ul className="flex-1">
          {shown.map((r) => {
            const k = renderingKey(r);
            const active = k === props.selectedKey;
            return (
              <li key={k}>
                <button
                  onClick={() => props.onSelect(k)}
                  className={`flex w-full flex-col gap-1.5 border-b border-line px-4 py-3 text-left transition-colors ${
                    active ? "bg-mint-soft/60 shadow-[inset_2px_0_0_var(--color-mint)]" : "hover:bg-bg"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[12px] font-medium text-muted">
                      {r.type} · {r.channel}
                    </span>
                    <span className="ml-auto">
                      <RenderingChip status={r.status} />
                    </span>
                  </div>
                  <p className="line-clamp-2 text-[13px] leading-snug text-ink/90">
                    {(r.text || "").replace(/\s+/g, " ").trim()}
                  </p>
                  <code className="truncate font-mono text-[10px] text-faint">{r.itemId}</code>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
