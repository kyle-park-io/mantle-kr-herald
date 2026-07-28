import { useEffect, useState } from "react";
import { api } from "./api";
import type { Translation, AppStatus, PublishStateRow } from "./types";
import { TranslationList } from "./components/TranslationList";
import { TranslationDetail } from "./components/TranslationDetail";
import { RenderingsView } from "./components/RenderingsView";

type Mode = "translations" | "renderings";

const FUNNEL_STEPS = [
  ["수집", "collected"],
  ["번역", "translated"],
  ["변환", "converted"],
  ["렌더", "rendered"],
  ["발행", "published"],
] as const;

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

  const isCloud = status?.storageMode === "cloud";
  const syncWarn = !!status && (status.sync.needsRepublish > 0 || status.sync.unpublished > 0);

  return (
    <div className="flex h-screen flex-col bg-bg text-ink">
      <header className="shrink-0 border-b border-line bg-surface">
        <div className="flex h-14 items-center gap-4 px-5">
          <div className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-mint" />
            <span className="text-[15px] font-semibold tracking-tight">
              Mantle KR <span className="text-faint font-normal">Review</span>
            </span>
          </div>

          {status && (
            <div className="group relative">
              <span
                className={`inline-flex cursor-default items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  isCloud ? "bg-mint-soft text-mint" : "bg-amber-soft text-amber-ink"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${isCloud ? "bg-mint" : "bg-amber-ink"}`} />
                {status.storageMode}
              </span>
              <div className="pointer-events-none absolute left-0 top-full z-30 mt-2 hidden w-64 rounded-lg border border-line bg-surface p-3 text-[12px] leading-relaxed text-muted shadow-lg group-hover:block">
                <p className="mb-1 font-semibold text-ink">
                  현재 <span className={isCloud ? "text-mint" : "text-amber-ink"}>{status.storageMode}</span> 모드
                </p>
                <p>
                  {isCloud
                    ? "발행하면 Google · Lark Drive에 올라갑니다."
                    : "발행하면 로컬 폴더(output/publish/local/)에 저장됩니다."}
                </p>
                <p className="mt-1.5 text-faint">
                  바꾸려면 서버를 끄고 <code className="font-mono">.env</code>의{" "}
                  <code className="font-mono">HERALD_STORAGE_MODE</code>를 고친 뒤 다시 실행하세요. 대시보드에서는 바꿀 수
                  없습니다.
                </p>
              </div>
            </div>
          )}

          <nav className="ml-2 inline-flex rounded-lg border border-line bg-bg p-0.5">
            {(
              [
                ["translations", "1차 검수 · 번역"],
                ["renderings", "2차 검수 · 채널"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={`rounded-[7px] px-3 py-1 text-[13px] font-medium transition-colors ${
                  mode === m ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          {status && (
            <div className="ml-auto hidden items-center gap-3 md:flex">
              <div className="flex items-center gap-1.5 text-[13px]">
                {FUNNEL_STEPS.map(([label, key], i) => (
                  <div key={key} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-line-strong">→</span>}
                    <span className="text-muted">{label}</span>
                    <span className="font-mono text-xs font-semibold tabular-nums">{status.funnel[key]}</span>
                  </div>
                ))}
              </div>
              <span className="h-4 w-px bg-line" />
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-medium ${syncWarn ? "text-amber-ink" : "text-mint"}`}
                title="발행됨 · 재발행 필요 · 미발행"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${syncWarn ? "bg-amber-ink" : "bg-mint"}`} />
                발행됨 {status.sync.synced}
                {status.sync.needsRepublish > 0 ? ` · 재발행 필요 ${status.sync.needsRepublish}` : ""}
                {status.sync.unpublished > 0 ? ` · 미발행 ${status.sync.unpublished}` : ""}
              </span>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">{error}</div>
      )}

      {mode === "translations" ? (
        <div className="flex min-h-0 flex-1">
          <aside className="w-80 shrink-0 overflow-y-auto border-r border-line bg-surface [scrollbar-gutter:stable]">
            <TranslationList items={items} selectedId={selectedId} onSelect={handleSelect} />
          </aside>
          <section className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
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
              <EmptyState title="검수할 항목을 선택하세요" hint="왼쪽 목록에서 번역을 골라 원문과 나란히 확인하고 승인합니다." />
            )}
          </section>
        </div>
      ) : (
        <RenderingsView onDirtyChange={setDirty} />
      )}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface text-faint">
          ☰
        </div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {hint && <p className="mt-1 text-[13px] leading-relaxed text-faint">{hint}</p>}
      </div>
    </div>
  );
}
