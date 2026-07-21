import { useState } from "react";
import type { Translation } from "../types";

type Filter = "all" | "translated" | "approved";

const badgeClass = (status: Translation["status"]) =>
  status === "approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800";

export function TranslationList(props: {
  items: Translation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = props.items.filter((t) => filter === "all" || t.status === filter);
  return (
    <div>
      <div className="flex gap-1.5 px-2.5 py-2 border-b border-neutral-200">
        {(["all", "translated", "approved"] as Filter[]).map((f) => (
          <button
            key={f}
            className={`text-sm px-2.5 py-1 rounded-full border ${filter === f ? "bg-neutral-900 text-white border-neutral-900" : "bg-white border-neutral-300"}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <ul>
        {shown.map((t) => (
          <li
            key={t.itemId}
            className={`flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-neutral-100 cursor-pointer hover:bg-neutral-50 ${t.itemId === props.selectedId ? "bg-indigo-50" : ""}`}
            onClick={() => props.onSelect(t.itemId)}
          >
            <span className="text-base text-neutral-600 truncate">{t.itemId}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${badgeClass(t.status)}`}>{t.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
