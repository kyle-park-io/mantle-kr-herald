import { useEffect, useState } from "react";
import { api } from "./api";
import type { Translation } from "./types";
import { TranslationList } from "./components/TranslationList";
import { TranslationDetail } from "./components/TranslationDetail";
import { PublishBar } from "./components/PublishBar";

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
    <div className="flex flex-col h-screen text-neutral-900">
      <header className="flex items-center justify-between gap-3 px-4 py-2.5 bg-neutral-950 text-white font-semibold">
        <span>Mantle KR — Review</span>
        <PublishBar />
      </header>
      {error && <div className="bg-red-100 text-red-800 px-4 py-2 text-sm">{error}</div>}
      <div className="flex flex-1 min-h-0">
        <aside className="w-72 border-r border-neutral-200 overflow-y-auto">
          <TranslationList items={items} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
        <section className="flex-1 p-6 overflow-y-auto">
          {selected ? (
            <TranslationDetail item={selected} onSave={onSave} onApprove={onApprove} />
          ) : (
            <p className="text-neutral-400">항목을 선택하세요.</p>
          )}
        </section>
      </div>
    </div>
  );
}
