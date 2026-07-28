import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { btnPrimary } from "../buttonStyles";
import { TYPE_LABEL, itemUrl, type BoardView, type ConversionType, type ConvertPrepareReply } from "../types";
import { OutletCard } from "./OutletCard";

/**
 * The 2차 surface: one card per `(type, channel)` group, each listing the rooms that receive it.
 * Review and delivery happen in the same place, so the reviewer never has to hold "which room did
 * this already go to" in their head.
 */
export function OutletBoard(props: {
  itemId: string;
  /**
   * `변환 원문` per conversion type. The board API carries only what is delivered; the source the
   * copy was written from comes from the rendering list, which already has it. Without it a
   * `lark:` item has no source context at all on this screen — `원문 ↗` is a different artifact
   * and `itemUrl` returns null for anything that is not an `x:` item.
   */
  convertedByType: Record<string, string>;
  /** The rendering list on the left carries status chips the card can change. */
  onGroupChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { itemId, onDirtyChange } = props;
  const [board, setBoard] = useState<BoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  // §10 [변환 준비]: which not-yet-converted types the operator picked, and the last worksheet
  // handoff for THIS item — cleared on an item switch so a stale path from the previous item is
  // never shown under a new one.
  const [prepareTypes, setPrepareTypes] = useState<Set<ConversionType>>(new Set());
  const [preparing, setPreparing] = useState(false);
  const [prepareResult, setPrepareResult] = useState<ConvertPrepareReply | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoard(await api.board(itemId));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [itemId]);

  useEffect(() => {
    setBoard(null);
    setError(null);
    setDirtyKeys(new Set());
    setPrepareTypes(new Set());
    setPrepareResult(null);
    void reload();
  }, [itemId, reload]);

  const onDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((prev) => {
      if (dirty === prev.has(key)) return prev;
      const next = new Set(prev);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  useEffect(() => {
    onDirtyChange(dirtyKeys.size > 0);
  }, [dirtyKeys, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const parentChanged = props.onGroupChanged;
  const onGroupChanged = useCallback(async () => {
    await Promise.all([parentChanged(), reload()]);
  }, [parentChanged, reload]);

  if (!board) {
    return (
      <div className="p-6 text-[13px] text-faint sm:p-8">
        {error ? <span className="text-red-600">{error}</span> : "발송판을 불러오는 중…"}
      </div>
    );
  }

  const rows = board.groups.flatMap((g) => g.rows);
  const done = rows.filter((r) => r.deliveryStatus).length;
  // First-appearance order, which is the board's own top-to-bottom order — the same order the
  // `n/m` badges were numbered in, so the summary and the cards read the same way.
  const outletIds = [...new Set(rows.map((r) => r.outletId))];
  const url = itemUrl(board.itemId);

  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-8">
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>
      )}

      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <code className="font-mono text-[12px] text-muted">{board.itemId}</code>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              원문 ↗
            </a>
          )}
        </div>
        <p className="mt-2 text-[13px] font-medium text-ink">
          수신처 {outletIds.length}곳 · {rows.length}건 중 {done}건 완료
        </p>
        {outletIds.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
            {outletIds.map((id) => {
              const mine = rows.filter((r) => r.outletId === id);
              const ok = mine.filter((r) => r.deliveryStatus).length;
              return (
                <span
                  key={id}
                  onMouseEnter={() => setHovered(id)}
                  onMouseLeave={() => setHovered(null)}
                  className={`rounded px-1 ${hovered === id ? "bg-mint-soft text-mint" : ""}`}
                >
                  {mine[0].label}{" "}
                  <span className={`font-mono tabular-nums ${ok === mine.length ? "text-mint" : "text-faint"}`}>
                    {ok}/{mine.length}
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </header>

      {board.groups.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface p-5 text-[13px] leading-relaxed text-faint shadow-sm">
          이 항목은 아직 렌더링이 없습니다. <code className="font-mono">pnpm format</code> 을 먼저 실행하세요.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {board.groups.map((g) => (
            <OutletCard
              key={`${g.type}:${g.channel}`}
              itemId={board.itemId}
              group={g}
              convertedText={props.convertedByType[g.type] ?? ""}
              hovered={hovered}
              onHover={setHovered}
              onBoard={setBoard}
              onGroupChanged={onGroupChanged}
              onError={setError}
              onDirty={onDirty}
            />
          ))}
        </div>
      )}

      {board.unconverted.length > 0 && (
        <details className="mt-5 rounded-xl border border-line bg-surface px-4 py-2.5 text-[13px] shadow-sm">
          {/* No `open` prop: the checkboxes/button below only exist while the operator already has
              this expanded (that is how they would have reached them), so React does not need to
              fight the browser's own open/close state after a successful prepare. */}
          <summary className="cursor-pointer text-muted marker:text-faint">
            아직 변환 안 됨 —{" "}
            <span className="text-ink">{board.unconverted.map((t) => TYPE_LABEL[t]).join(" · ")}</span>
          </summary>
          <p className="mt-2 text-[12px] leading-relaxed text-faint">
            대시보드는 변환하지 않습니다 — 여기서는 유형을 골라 워크시트만 준비할 수 있습니다. 에이전트가
            채운 뒤 <code className="font-mono">pnpm convert:save</code> 와{" "}
            <code className="font-mono">pnpm format</code> 을 실행하면 여기에 카드가 생깁니다.
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            {board.unconverted.map((t) => (
              <label key={t} className="inline-flex items-center gap-1.5 text-[12px] text-ink">
                <input
                  type="checkbox"
                  checked={prepareTypes.has(t)}
                  onChange={(e) =>
                    setPrepareTypes((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(t);
                      else next.delete(t);
                      return next;
                    })
                  }
                />
                {TYPE_LABEL[t]}
              </label>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <button
              className={btnPrimary}
              disabled={preparing || prepareTypes.size === 0}
              onClick={() => {
                setPreparing(true);
                setError(null);
                setPrepareResult(null);
                api
                  .convertPrepare(board.itemId, [...prepareTypes])
                  .then(setPrepareResult)
                  .catch((e) => setError(String((e as Error).message ?? e)))
                  .finally(() => setPreparing(false));
              }}
            >
              변환 준비
            </button>
            {prepareResult &&
              (prepareResult.pending > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-[12px] font-medium text-mint">
                    워크시트 준비됨 — 에이전트에게 변환을 요청하세요:{" "}
                    <code className="font-mono text-ink">{prepareResult.worksheetPath}</code>
                  </p>
                  {prepareResult.archived && (
                    <p className="text-[11px] font-medium text-amber-ink">
                      ⚠ 이전에 준비했던 미저장 배치는 보관되었습니다 —{" "}
                      <code className="font-mono">{prepareResult.archived}</code>. 에이전트가 그 배치를 채우던
                      중이었다면 다시 변환 준비가 필요합니다.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-[12px] text-faint">
                  대기 중인 항목이 없습니다 — 승인된 원문이 없거나 이미 변환된 상태입니다. 이미 변환됐다면{" "}
                  <code className="font-mono">pnpm format</code> 을 실행하면 여기에 카드가 생깁니다.
                </p>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}
