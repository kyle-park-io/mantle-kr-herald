import { useEffect, useState } from "react";
import { api } from "./api";
import type { Translation } from "./types";
import { TranslationList } from "./components/TranslationList";

export function App() {
  const [items, setItems] = useState<Translation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.list().then(setItems).catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <div className="app">
      <header className="topbar">Mantle KR — Review</header>
      {error && <div className="banner error">{error}</div>}
      <div className="main">
        <aside className="sidebar">
          <TranslationList items={items} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
        <section className="detail">
          {selectedId ? <p>선택됨: {selectedId}</p> : <p className="empty">항목을 선택하세요.</p>}
        </section>
      </div>
    </div>
  );
}
