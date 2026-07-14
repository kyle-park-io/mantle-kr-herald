import { useState } from "react";
import type { Translation } from "../types";

type Filter = "all" | "translated" | "approved";

export function TranslationList(props: {
  items: Translation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = props.items.filter((t) => filter === "all" || t.status === filter);
  return (
    <div>
      <div className="filter">
        {(["all", "translated", "approved"] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? "chip-on" : ""}`} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      <ul className="list">
        {shown.map((t) => (
          <li
            key={t.itemId}
            className={`list-item ${t.itemId === props.selectedId ? "selected" : ""}`}
            onClick={() => props.onSelect(t.itemId)}
          >
            <span className="list-id">{t.itemId}</span>
            <span className={`badge badge-${t.status}`}>{t.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
