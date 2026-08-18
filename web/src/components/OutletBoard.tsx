import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { btnPrimary } from "../buttonStyles";
import {
  TYPE_LABEL,
  datePrefix,
  deliveredToRoom,
  itemUrl,
  LOW_PUBLISHING_QUOTA,
  type BoardView,
  type ConversionType,
  type ConvertPrepareReply,
  type Headroom,
  type HeadroomView,
} from "../types";
import { OutletCard } from "./OutletCard";
import { ConfirmDialog, Tip, type ConfirmRequest } from "./ConfirmDialog";
import { KindBadge } from "./TranslationList";

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
  /** Source-item display metadata, mirroring 1차's header. Absent for a Lark item. */
  postedAt?: string;
  kind?: "post" | "article";
  /** The rendering list on the left carries status chips the card can change. */
  onGroupChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  /**
   * Bumped by `Root.tsx` on every successful login — see its own doc comment for the full story.
   * `OutletBoard` is keyed by `itemId` (`RenderingsView`'s render site), so a session lapsing and the
   * reviewer logging back in on the SAME item does not remount this component the way switching items
   * does; without threading this through, `reload`'s and `loadQuota`'s effects below — both mount-only
   * otherwise — would never retry, and the 발송판 (and the Typefully headroom banner) would sit on
   * their last-fetched state (or, for a cold-start login landing straight on this screen, never load
   * at all) until the reviewer manually re-selected the item.
   */
  authEpoch: number;
  /** See `OutletCard`'s same-named prop — passed straight through to every card on this board. */
  sendsEnabled: boolean;
  /**
   * `StatusView.conversionEnabled` — false on the hosted route set, where `convert-prepare` is a 404
   * because the local agent that fills the worksheet is not there. Drops the [변환 준비] action
   * rather than disabling it: unlike a locked [발송], which the same team opens later with one env
   * var, no state of this deployment will ever make it work.
   */
  conversionEnabled: boolean;
}) {
  const { itemId, onDirtyChange, authEpoch, conversionEnabled } = props;
  const [board, setBoard] = useState<BoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [headroom, setHeadroom] = useState<Headroom | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  // §10 [변환 준비]: which not-yet-converted types the operator picked, and the last worksheet
  // handoff for THIS item — cleared on an item switch so a stale path from the previous item is
  // never shown under a new one.
  const [prepareTypes, setPrepareTypes] = useState<Set<ConversionType>>(new Set());
  const [preparing, setPreparing] = useState(false);
  const [prepareResult, setPrepareResult] = useState<ConvertPrepareReply | null>(null);
  /** One dialog for the whole board, so two rows can never stack confirms on each other. */
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoard(await api.board(itemId));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [itemId]);

  /**
   * How much Typefully publishing headroom is left, for the banner above the group cards. An
   * unreadable headroom is not an empty one — show nothing rather than paint a healthy account as
   * blocked at `0건`.
   *
   * The server computes `available` (and every other field) — this component no longer does that
   * arithmetic itself, so the banner can never drift from what the send gate actually enforces.
   */
  const loadQuota = useCallback(async () => {
    const r: HeadroomView = await api.typefullyQuota();
    setHeadroom(r.headroom ?? null);
  }, []);

  /**
   * Every mutating board route answers through `onBoard`, but only a real send and a reconcile pass
   * (게시 확인) can move the Typefully quota — `OutletCard` passes `quotaMayHaveChanged` only from
   * those two call sites. Refetching here on every board update would also fire on 전달함 ticks,
   * saves, approvals and reverts, none of which touch Typefully.
   */
  const handleBoard = useCallback(
    (next: BoardView, quotaMayHaveChanged?: boolean) => {
      setBoard(next);
      if (quotaMayHaveChanged) void loadQuota();
    },
    [loadQuota],
  );

  // Split from the reload effect below on purpose. `OutletBoard` is keyed by `itemId`
  // (`RenderingsView`), so in practice this only ever runs once, on mount, for a fresh instance whose
  // state already starts at exactly these defaults — but it must NOT also re-run on an `authEpoch`
  // bump: an authEpoch-triggered re-auth happens on the SAME instance, possibly with a reviewer's
  // in-progress edit live in a child `OutletCard`, and resetting `dirtyKeys` (or blanking `board`,
  // which would unmount every `OutletCard` and throw its local draft away) would reintroduce, one
  // level below it, the exact defect `Root.tsx`'s `authEpoch` mechanism exists to prevent in 1차.
  useEffect(() => {
    setBoard(null);
    setError(null);
    setDirtyKeys(new Set());
    setPrepareTypes(new Set());
    setPrepareResult(null);
  }, [itemId]);

  // `authEpoch` (`Root.tsx`'s own doc comment has the full story) alongside `itemId`: a session that
  // lapses while `reload` is in flight — or before it ever gets a session to succeed with — leaves
  // `board` stuck on `null`/an error with no way to retry once the reviewer logs back in, since this
  // component is not remounted by a re-auth alone (only an item switch, via `RenderingsView`'s
  // `key={itemId}`, does that). Calling `reload()` again here on an `authEpoch` bump is what retries
  // it — safely, because `reload` itself replaces `board` with the fetched value directly rather than
  // nulling it first, so a successful refetch with no intervening save never unmounts an `OutletCard`
  // that has an unsaved edit live (same value-based-reset guarantee `OutletCard`'s own effect relies
  // on).
  useEffect(() => {
    void reload();
  }, [itemId, authEpoch, reload]);

  // Same reasoning as the effect above, for the Typefully headroom banner: `loadQuota` has no
  // `itemId` dependency of its own (the account-wide quota is not per-item), so without `authEpoch`
  // here a re-auth would leave a stale or blank banner behind rather than refreshing it.
  useEffect(() => {
    void loadQuota();
  }, [loadQuota, authEpoch]);

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

  // 저장 / 승인하기 / 승인 취소 — the group-text mutations `OutletCard` raises through this prop —
  // never reach Typefully, so this intentionally does not touch the quota; see `handleBoard` above
  // for the two calls that do.
  const parentChanged = props.onGroupChanged;
  const onGroupChanged = useCallback(async () => {
    await Promise.all([parentChanged(), reload()]);
  }, [parentChanged, reload]);

  if (!board) {
    return (
      <div className="p-6 text-[13px] text-faint tablet:p-8">
        {error ? <span className="text-red-600">{error}</span> : "발송판을 불러오는 중…"}
      </div>
    );
  }

  const rows = board.groups.flatMap((g) => g.rows);
  const done = rows.filter(deliveredToRoom).length;
  // First-appearance order, which is the board's own top-to-bottom order — the same order the
  // `n/m` badges were numbered in, so the summary and the cards read the same way.
  const outletIds = [...new Set(rows.map((r) => r.outletId))];
  const url = itemUrl(board.itemId);
  // The number the send gate (`SendChannels`) actually enforces, not the raw account total —
  // clamped because a stale `inFlight` count must read as "none left", not as a bug (`잔여 -2건`).
  // The server does NOT clamp `available` itself (see `Headroom` in types.ts) — only this display does.
  const availableQuota = headroom ? Math.max(0, headroom.available) : 0;

  /**
   * Jump to a room's first row. A DOM query rather than a ref map because the rows live inside
   * `OutletCard`, one component down and one per group — threading a ref through every card to
   * reach a room that may be in several of them buys nothing over the attribute the row already
   * carries. `hovered` is set too, so the row is visibly marked once the scroll lands.
   */
  const scrollToOutlet = (outletId: string): void => {
    setHovered(outletId);
    document
      .querySelector(`[data-outlet="${CSS.escape(outletId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="mx-auto max-w-3xl p-6 tablet:p-8">
      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>
      )}

      {/* Same shape as 1차's detail header — date, the id itself as the link, kind badge — so the
          two modes read as one screen rather than two. `itemUrl` is null for a `lark:` item, which
          is why the id still renders as plain code when there is nothing to link to.

          The phone treatment is the same call `TranslationDetail` made for this exact shape, not a
          new one: `board.itemId` is a link's visible text here too (same `href`/`target`/`rel`,
          untouched), so it swaps for `원문 ↗` rather than dropping outright the way the (non-link)
          list rows do — a link needs *something* tappable in its place, and repeating what `KindBadge`
          already says would waste the slot. `tablet:` brings the full id back for the CLI-copy use it
          still has at a desk. */}
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2.5">
          {props.postedAt && (
            <span className="font-mono text-[13px] font-medium text-faint">{datePrefix(props.postedAt)}</span>
          )}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[13px] text-muted underline-offset-2 hover:text-mint hover:underline"
            >
              <span className="tablet:hidden">원문 ↗</span>
              <span className="hidden tablet:inline">{board.itemId}</span>
            </a>
          ) : (
            // No `postedUrl` (a `lark:` item), so there is nothing to send the reader to — same
            // split as `TranslationDetail`'s own no-link branch: drop the `↗`, keep the tablet-only id.
            <code className="font-mono text-[13px] text-muted">
              <span className="tablet:hidden">원문</span>
              <span className="hidden tablet:inline">{board.itemId}</span>
            </code>
          )}
          <KindBadge kind={props.kind} />
        </div>
        <p className="mt-2 text-[13px] font-medium text-ink">
          수신처 {outletIds.length}곳 · {rows.length}건 중 {done}건 완료
        </p>
        {outletIds.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted">
            {outletIds.map((id) => {
              const mine = rows.filter((r) => r.outletId === id);
              const ok = mine.filter(deliveredToRoom).length;
              return (
                <Tip key={id} text={`${mine[0].label} 줄로 이동`}>
                  <button
                    type="button"
                    onMouseEnter={() => setHovered(id)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => scrollToOutlet(id)}
                    className={`rounded px-1 ${hovered === id ? "bg-mint-soft text-mint" : "hover:bg-bg"}`}
                  >
                    {mine[0].label}{" "}
                    <span className={`font-mono tabular-nums ${ok === mine.length ? "text-mint" : "text-faint"}`}>
                      {ok}/{mine.length}
                    </span>
                  </button>
                </Tip>
              );
            })}
          </div>
        )}
      </header>

      {headroom && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-[13px] ${
            availableQuota <= LOW_PUBLISHING_QUOTA
              ? "border-amber-ink/20 bg-amber-soft text-amber-ink"
              : "border-line bg-surface text-muted"
          }`}
        >
          X 발행 잔여 <strong className="font-semibold">{availableQuota}건</strong>
          {headroom.inFlight > 0 ? ` (예약 ${headroom.inFlight}건 대기)` : ""} / {headroom.used + headroom.remaining}건
          {headroom.resetsAt ? ` · ${headroom.resetsAt.slice(5, 10).replace("-", "/")} 리셋` : ""}
        </div>
      )}

      {board.groups.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface p-5 text-[13px] leading-relaxed text-faint shadow-sm">
          이 항목은 아직 렌더링이 없습니다. <code className="font-mono">pnpm format --only-missing</code> 을 먼저
          실행하세요.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {board.groups.map((g) => (
            <OutletCard
              key={`${g.type}:${g.channel}`}
              itemId={board.itemId}
              group={g}
              sendsEnabled={props.sendsEnabled}
              convertedText={props.convertedByType[g.type] ?? ""}
              hovered={hovered}
              onHover={setHovered}
              onBoard={handleBoard}
              onGroupChanged={onGroupChanged}
              onError={setError}
              onDirty={onDirty}
              onConfirm={setConfirm}
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
          {conversionEnabled ? (
            <>
              <p className="mt-2 text-[13px] leading-relaxed text-faint">
                대시보드는 변환하지 않습니다 — 여기서는 유형을 골라 워크시트만 준비할 수 있습니다. 에이전트가
                채운 뒤 <code className="font-mono">pnpm convert:save</code> 와{" "}
                <code className="font-mono">pnpm format --only-missing</code> 을 실행하면 여기에 카드가 생깁니다.
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-3">
                {board.unconverted.map((t) => (
                  <label key={t} className="inline-flex items-center gap-1.5 text-[13px] text-ink">
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
                      <p className="text-[13px] font-medium text-mint">
                        워크시트 준비됨 — 에이전트에게 변환을 요청하세요:{" "}
                        <code className="font-mono text-ink">{prepareResult.worksheetPath}</code>
                      </p>
                      {prepareResult.archived && (
                        <p className="text-[12px] font-medium text-amber-ink">
                          ⚠ 이전에 준비했던 미저장 배치는 보관되었습니다 —{" "}
                          <code className="font-mono">{prepareResult.archived}</code>. 에이전트가 그 배치를 채우던
                          중이었다면 다시 변환 준비가 필요합니다.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-[13px] text-faint">
                      대기 중인 항목이 없습니다 — 승인된 원문이 없거나 이미 변환된 상태입니다. 이미 변환됐다면{" "}
                      <code className="font-mono">pnpm format --only-missing</code> 을 실행하면 여기에 카드가
                      생깁니다.
                    </p>
                  ))}
              </div>
            </>
          ) : (
            <p className="mt-2 text-[13px] leading-relaxed text-faint">
              이 배포에서는 워크시트를 준비할 수 없습니다 — 워크시트를 채우는 에이전트가 여기에 없습니다.
              변환은 로컬에서 <code className="font-mono">pnpm convert:prepare</code> 를 실행하세요.
            </p>
          )}
        </details>
      )}
    </div>
  );
}
