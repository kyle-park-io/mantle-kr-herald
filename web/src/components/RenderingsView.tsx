import { useEffect, useState } from "react";
import { api } from "../api";
import { renderingKey, type Rendering } from "../types";
import { RenderingList } from "./RenderingList";
import { RenderingDetail } from "./RenderingDetail";

export function RenderingsView(props: { onDirtyChange: (dirty: boolean) => void }) {
  const { onDirtyChange } = props;
  const [items, setItems] = useState<Rendering[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const refresh = () => api.listRenderings().then(setItems).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const selected = items.find((r) => renderingKey(r) === selectedKey) ?? null;

  const handleSelect = (k: string) => {
    if (dirty && !window.confirm("저장하지 않은 편집이 있습니다. 그래도 이동할까요?")) return;
    setSelectedKey(k);
  };
  const onSave = async (item: Rendering, text: string): Promise<string | undefined> => {
    setError(null);
    try {
      const updated = await api.editRendering(item.itemId, item.type, item.channel, text);
      await refresh();
      return updated.text;
    } catch (e) {
      setError(String((e as Error).message ?? e));
      return undefined;
    }
  };
  const onApprove = async (item: Rendering) => {
    setError(null);
    try {
      await api.approveRendering(item.itemId, item.type, item.channel);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <>
      {error && (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">{error}</div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-y-auto border-r border-line bg-surface [scrollbar-gutter:stable]">
          <RenderingList items={items} selectedKey={selectedKey} onSelect={handleSelect} />
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {selected ? (
            <RenderingDetail item={selected} onSave={onSave} onApprove={onApprove} onDirtyChange={setDirty} />
          ) : (
            <div className="flex h-full items-center justify-center p-10">
              <div className="max-w-sm text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface text-faint">
                  ☰
                </div>
                <p className="text-sm font-medium text-ink">검수할 렌더링을 선택하세요</p>
                <p className="mt-1 text-[13px] leading-relaxed text-faint">
                  목록이 비어 있으면 먼저 <code className="font-mono">pnpm format</code> 을 실행하세요.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
