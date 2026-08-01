import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { type Rendering } from "../types";
import { RenderingList } from "./RenderingList";
import { OutletBoard } from "./OutletBoard";

export function RenderingsView(props: { onDirtyChange: (dirty: boolean) => void; authEpoch: number }) {
  const { onDirtyChange, authEpoch } = props;
  const [items, setItems] = useState<Rendering[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const refresh = useCallback(
    () => api.listRenderings().then(setItems).catch((e) => setError(String(e.message ?? e))),
    [],
  );
  // `authEpoch` — see `Root.tsx`'s doc comment: `<App>` (this component's parent) now only ever
  // hides across a `#login` round trip, never remounts, so without it a cold-start login (landing
  // here first, e.g. a bookmarked `#renderings`) would 401 once and never retry.
  useEffect(() => {
    void refresh();
  }, [refresh, authEpoch]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // The selection is an item, not a rendering: the board already opens every group an item has, so
  // a per-rendering selection offered the same board under three different rows.
  const selected = items.find((r) => r.itemId === selectedId) ?? null;

  const handleSelect = (itemId: string) => {
    if (dirty && !window.confirm("저장하지 않은 편집이 있습니다. 그래도 이동할까요?")) return;
    setSelectedId(itemId);
  };

  return (
    <>
      {error && (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">{error}</div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-y-auto border-r border-line bg-surface [scrollbar-gutter:stable]">
          <RenderingList items={items} selectedId={selectedId} onSelect={handleSelect} />
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {selected ? (
            // The board is per *item*, not per rendering: picking any of an item's renderings opens
            // every group that item has, because delivery is decided across them (a room receiving
            // both 공지 and 해설 has to be seen as one room).
            <OutletBoard
              // Keyed by item, so switching items remounts rather than reusing the previous item's
              // state. Without it, a mutation still in flight resolves into the new item's board and
              // repaints it with the previous item's rows — the actions stay correct (they carry
              // `board.itemId`), but the screen shows one item's delivery state under another's id.
              key={selected.itemId}
              itemId={selected.itemId}
              convertedByType={Object.fromEntries(
                items.filter((r) => r.itemId === selected.itemId).map((r) => [r.type, r.convertedText]),
              )}
              postedAt={selected.postedAt}
              kind={selected.kind}
              onGroupChanged={refresh}
              onDirtyChange={setDirty}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-10">
              <div className="max-w-sm text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface text-faint">
                  ☰
                </div>
                <p className="text-sm font-medium text-ink">검수하고 보낼 항목을 선택하세요</p>
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
