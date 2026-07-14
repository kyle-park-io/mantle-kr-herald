import type { Translation } from "../types";

export function TranslationList(props: {
  items: Translation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="list">
      {props.items.map((t) => (
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
  );
}
