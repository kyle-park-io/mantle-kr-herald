import { useEffect, useState } from "react";
import { api } from "./api";
import type { Translation } from "./types";
import { TranslationList } from "./components/TranslationList";
import { TranslationDetail } from "./components/TranslationDetail";

export function App() {
  const [items, setItems] = useState<Translation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.list().then(setItems).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => {
    refresh();
  }, []);

  const selected = items.find((t) => t.itemId === selectedId) ?? null;

  const onSave = async (id: string, koreanText: string) => {
    setError(null);
    try {
      await api.edit(id, koreanText);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onApprove = async (id: string) => {
    setError(null);
    try {
      await api.approve(id);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <div className="app">
      <header className="topbar">Mantle KR — Review</header>
      {error && <div className="banner error">{error}</div>}
      <div className="main">
        <aside className="sidebar">
          <TranslationList items={items} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
        <section className="detail">
          {selected ? (
            <TranslationDetail item={selected} onSave={onSave} onApprove={onApprove} />
          ) : (
            <p className="empty">항목을 선택하세요.</p>
          )}
        </section>
      </div>
    </div>
  );
}
