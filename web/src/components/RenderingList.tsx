import { useState } from "react";
import { renderingKey, type Rendering } from "../types";

const badgeClass = (status: Rendering["status"]) =>
  status === "approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800";

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
    <div>
      <div className="flex flex-wrap gap-1.5 px-2.5 py-2 border-b border-neutral-200">
        {(["all", "rendered", "approved"] as const).map((f) => (
          <button
            key={f}
            className={`text-sm px-2.5 py-1 rounded-full border ${status === f ? "bg-neutral-900 text-white border-neutral-900" : "bg-white border-neutral-300"}`}
            onClick={() => setStatus(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 px-2.5 py-2 border-b border-neutral-200">
        <select className="text-sm border border-neutral-300 rounded px-1 py-0.5" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
          <option value="all">all channels</option>
          <option value="x">x</option>
          <option value="telegram">telegram</option>
          <option value="kakao">kakao</option>
          <option value="pr_mail">pr_mail</option>
        </select>
        <select className="text-sm border border-neutral-300 rounded px-1 py-0.5" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="all">all types</option>
          <option value="x">x</option>
          <option value="announcement">announcement</option>
          <option value="kol">kol</option>
          <option value="pr">pr</option>
        </select>
      </div>
      <ul>
        {shown.map((r) => {
          const k = renderingKey(r);
          return (
            <li
              key={k}
              className={`flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-neutral-100 cursor-pointer hover:bg-neutral-50 ${k === props.selectedKey ? "bg-indigo-50" : ""}`}
              onClick={() => props.onSelect(k)}
            >
              <span className="text-base text-neutral-600 truncate">{r.itemId} · {r.type} · {r.channel}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${badgeClass(r.status)}`}>{r.status}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
