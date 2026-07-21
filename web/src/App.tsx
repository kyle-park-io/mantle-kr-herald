import { useEffect, useState } from "react";
import { api } from "./api";
import type { Translation, AppStatus, PublishStateRow } from "./types";
import { TranslationList } from "./components/TranslationList";
import { TranslationDetail } from "./components/TranslationDetail";
import { RenderingsView } from "./components/RenderingsView";

type Mode = "translations" | "renderings";

export function App() {
  const [mode, setMode] = useState<Mode>("translations");
  const [items, setItems] = useState<Translation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [publishRows, setPublishRows] = useState<PublishStateRow[]>([]);

  const refresh = () => api.list().then(setItems).catch((e) => setError(String(e.message ?? e)));

  const refreshStatus = () => {
    api.status().then(setStatus).catch(() => setStatus(null));
    api.publishState().then(setPublishRows).catch(() => setPublishRows([]));
  };
  useEffect(() => {
    refresh();
    refreshStatus();
  }, []);

  const selected = items.find((t) => t.itemId === selectedId) ?? null;

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    if (dirty && !window.confirm("저장하지 않은 편집이 있습니다. 모드를 바꿀까요?")) return;
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
      refreshStatus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onPublishOne = async (id: string, target: string) => {
    setError(null);
    try {
      const res = await api.publishOne(id, target);
      refreshStatus(); // refreshes both status and publish state (App.tsx's refreshStatus fetches both)
      if (res.failed > 0) setError(`발행 실패: ${res.failures.map((f) => f.error).join("; ")}`);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onUnapprove = async (id: string) => {
    setError(null);
    try {
      await api.unapprove(id);
      await refresh();
      refreshStatus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const tab = (active: boolean) =>
    `text-sm px-2.5 py-1 rounded-md ${active ? "bg-white text-neutral-900" : "bg-white/10 text-white"}`;

  return (
    <div className="flex flex-col h-screen text-neutral-900">
      <header className="bg-neutral-950 text-white">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 font-semibold">
          <div className="flex items-center gap-3">
            <span>Mantle KR — Review</span>
            {status && (
              <span
                className={`text-sm font-semibold px-2 py-0.5 rounded ${status.storageMode === "cloud" ? "bg-green-500 text-white" : "bg-amber-400 text-neutral-900"}`}
              >
                {status.storageMode}
              </span>
            )}
            <nav className="flex gap-1">
              <button className={tab(mode === "translations")} onClick={() => switchMode("translations")}>1차 검수 (번역)</button>
              <button className={tab(mode === "renderings")} onClick={() => switchMode("renderings")}>2차 검수 (채널)</button>
            </nav>
          </div>
        </div>
        {status && (
          <div className="px-4 pb-1.5 text-xs text-neutral-300 font-normal">
            수집 {status.funnel.collected} → 번역 {status.funnel.translated} → 변환 {status.funnel.converted} → 렌더 {status.funnel.rendered} → 발행 {status.funnel.published}
            <span className="ml-3">
              {status.sync.unsynced > 0 || status.sync.stale > 0 ? "⚠ " : ""}
              sync: {status.sync.published} published{status.sync.unsynced > 0 ? ` · ${status.sync.unsynced} unsynced` : ""}{status.sync.stale > 0 ? ` · ${status.sync.stale} stale` : ""}
            </span>
          </div>
        )}
      </header>

      {mode === "translations" ? (
        <>
          {error && <div className="bg-red-100 text-red-800 px-4 py-2 text-sm">{error}</div>}
          <div className="flex flex-1 min-h-0">
            <aside className="w-72 border-r border-neutral-200 overflow-y-auto [scrollbar-gutter:stable]">
              <TranslationList items={items} selectedId={selectedId} onSelect={handleSelect} />
            </aside>
            <section className="flex-1 p-6 overflow-y-auto [scrollbar-gutter:stable]">
              {selected ? (
                <TranslationDetail
                  item={selected}
                  publishRows={publishRows.filter((r) => r.itemId === selected.itemId)}
                  availableTargets={status?.availableTargets ?? []}
                  onSave={onSave}
                  onApprove={onApprove}
                  onUnapprove={onUnapprove}
                  onPublish={onPublishOne}
                  onDirtyChange={setDirty}
                />
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
