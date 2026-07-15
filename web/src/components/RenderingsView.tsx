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
  const onSave = async (item: Rendering, text: string) => {
    setError(null);
    try {
      await api.editRendering(item.itemId, item.type, item.channel, text);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
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
      {error && <div className="bg-red-100 text-red-800 px-4 py-2 text-sm">{error}</div>}
      <div className="flex flex-1 min-h-0">
        <aside className="w-72 border-r border-neutral-200 overflow-y-auto">
          <RenderingList items={items} selectedKey={selectedKey} onSelect={handleSelect} />
        </aside>
        <section className="flex-1 p-6 overflow-y-auto">
          {selected ? (
            <RenderingDetail item={selected} onSave={onSave} onApprove={onApprove} onDirtyChange={setDirty} />
          ) : (
            <p className="text-neutral-400">
              항목을 선택하세요. (렌더링이 없으면 먼저 <code>pnpm format</code> 실행)
            </p>
          )}
        </section>
      </div>
    </>
  );
}
