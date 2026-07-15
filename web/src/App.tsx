import { useEffect, useState } from "react";
import { api } from "./api";
import type { Translation } from "./types";
import { TranslationList } from "./components/TranslationList";
import { TranslationDetail } from "./components/TranslationDetail";
import { PublishBar } from "./components/PublishBar";
import { RenderingsView } from "./components/RenderingsView";

type Mode = "translations" | "renderings";

export function App() {
  const [mode, setMode] = useState<Mode>("translations");
  const [items, setItems] = useState<Translation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const refresh = () => api.list().then(setItems).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => {
    refresh();
  }, []);

  const selected = items.find((t) => t.itemId === selectedId) ?? null;

  const switchMode = (m: Mode) => {
    if (m !== mode && dirty && !window.confirm("저장하지 않은 편집이 있습니다. 모드를 바꿀까요?")) return;
    setDirty(false);
    setMode(m);
  };

  const handleSelect = (id: string) => {
    if (dirty && !window.confirm("저장하지 않은 편집이 있습니다. 그래도 이동할까요?")) return;
    setSelectedId(id);
  };
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

  const tab = (active: boolean) =>
    `text-sm px-2.5 py-1 rounded-md ${active ? "bg-white text-neutral-900" : "bg-white/10 text-white"}`;

  return (
    <div className="flex flex-col h-screen text-neutral-900">
      <header className="flex items-center justify-between gap-3 px-4 py-2.5 bg-neutral-950 text-white font-semibold">
        <div className="flex items-center gap-3">
          <span>Mantle KR — Review</span>
          <nav className="flex gap-1">
            <button className={tab(mode === "translations")} onClick={() => switchMode("translations")}>1차 검수 (번역)</button>
            <button className={tab(mode === "renderings")} onClick={() => switchMode("renderings")}>2차 검수 (채널)</button>
          </nav>
        </div>
        {mode === "translations" && <PublishBar />}
      </header>

      {mode === "translations" ? (
        <>
          {error && <div className="bg-red-100 text-red-800 px-4 py-2 text-sm">{error}</div>}
          <div className="flex flex-1 min-h-0">
            <aside className="w-72 border-r border-neutral-200 overflow-y-auto">
              <TranslationList items={items} selectedId={selectedId} onSelect={handleSelect} />
            </aside>
            <section className="flex-1 p-6 overflow-y-auto">
              {selected ? (
                <TranslationDetail item={selected} onSave={onSave} onApprove={onApprove} onDirtyChange={setDirty} />
              ) : (
                <p className="text-neutral-400">항목을 선택하세요.</p>
              )}
            </section>
          </div>
        </>
      ) : (
        <RenderingsView onDirtyChange={setDirty} />
      )}
    </div>
  );
}
