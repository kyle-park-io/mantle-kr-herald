import { useEffect, useState } from "react";
import { api } from "../api";
import {
  CHANNEL_LABEL,
  DESTINATION_LABEL,
  OUTLET_DELIVERY,
  PASTE_DESTINATION,
  TYPE_LABEL,
  outletLabel,
  type BoardGroup,
  type BoardRow,
  type BoardView,
  type Destination,
  type Emissions,
} from "../types";
import { RenderingChip } from "./RenderingList";

/**
 * A room the reviewer added from "+ 다른 방 추가". It is a row on screen and nothing on the server:
 * there is no "add room" route, because a room joins a group by acquiring an override or a
 * delivery. So it stands in as an unforked row — same text, same resolved status as the group —
 * until the operator sends it, ticks it, or gives it its own text, at which point the server rows
 * it for real on every later load.
 */
type ViewRow = BoardRow & { pending?: boolean };

/** ISO → `07-29 14:03`. Long enough to tell two sends apart, short enough to sit inside a row. */
const stamp = (iso?: string): string => (iso && iso.length >= 16 ? iso.slice(5, 16).replace("T", " ") : "");

const btn =
  "rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-bg disabled:cursor-default disabled:opacity-40";
const btnPrimary =
  "rounded-md bg-mint px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-mint-hover disabled:opacity-40";
const btnDanger =
  "rounded-md border border-red-200 bg-surface px-2.5 py-1 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40";

export function OutletCard(props: {
  itemId: string;
  group: BoardGroup;
  /** The room the pointer is over, board-wide — a room in two cards highlights in both. */
  hovered: string | null;
  onHover: (outletId: string | null) => void;
  /** Every mutating route answers with the rebuilt board; hand it straight up. */
  onBoard: (board: BoardView) => void;
  /** The group text lives in the rendering store, whose routes do not answer with a board. */
  onGroupChanged: () => Promise<void>;
  onError: (message: string | null) => void;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const { itemId, group, onDirty, onError } = props;
  const { type, channel } = group;
  const cardKey = `${type}:${channel}`;

  const [text, setText] = useState(group.text);
  const [busy, setBusy] = useState(false);
  const [emissions, setEmissions] = useState<Emissions>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);

  useEffect(() => setText(group.text), [group.text]);

  // The paste spelling and the over-limit warnings both come from here. RenderingDetail's tab strip
  // is not on the board — a reviewer about to post to a live room needs the warning, not the tabs.
  useEffect(() => {
    let live = true;
    api
      .emissions(itemId, type, channel)
      .then((e) => live && setEmissions(e))
      .catch(() => live && setEmissions({}));
    return () => {
      live = false;
    };
  }, [itemId, type, channel, group.text]);

  const dirty = text !== group.text || Object.entries(drafts).some(([id, d]) => d !== undefined && d !== rowText(id));
  useEffect(() => {
    onDirty(cardKey, dirty);
  }, [cardKey, dirty, onDirty]);
  useEffect(() => () => onDirty(cardKey, false), [cardKey, onDirty]);

  function rowText(outletId: string): string {
    return group.rows.find((r) => r.outletId === outletId)?.text ?? group.text;
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  /** Drop the row's local draft so the next render re-reads the text the server just stored. */
  const settle = (outletId: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[outletId];
      return next;
    });

  const pasteText = (): string => {
    const e = emissions[PASTE_DESTINATION[channel]];
    return e ? e.segments.map((s) => s.text).join("\n\n") : group.text;
  };
  const copy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const warnings = (Object.keys(emissions) as Destination[]).flatMap((d) =>
    (emissions[d]?.warnings ?? []).map((w) => `${DESTINATION_LABEL[d]} — ${w}`),
  );

  const pending: ViewRow[] = added
    .filter((id) => !group.rows.some((r) => r.outletId === id))
    .map((id) => ({
      outletId: id,
      label: outletLabel(id),
      delivery: OUTLET_DELIVERY[id] ?? "manual",
      forked: false,
      // An unforked room resolves to the group's text and the group's approval — the same rule the
      // server applies, so a pending row locks and unlocks exactly as it will once it is real.
      status: group.status,
      text: group.text,
      siblingCount: 1,
      siblingIndex: 1,
      pending: true,
    }));
  const rows: ViewRow[] = [...group.rows, ...pending];
  const addable = group.addableOutletIds.filter((id) => !added.includes(id));

  return (
    <article className="rounded-xl border border-line bg-surface shadow-sm">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5">
        <span className="rounded-md border border-line bg-bg px-2 py-0.5 text-[12px] font-medium text-ink">
          {TYPE_LABEL[type]} · {CHANNEL_LABEL[channel]}
        </span>
        <RenderingChip status={group.status} />
        {dirty && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-ink" />
            편집 중
          </span>
        )}
        <span className="ml-auto text-[11px] text-faint">
          {rows.filter((r) => r.deliveryStatus).length}/{rows.length}곳 완료
        </span>
      </header>

      <div className="px-4 py-3">
        <textarea
          className="min-h-40 w-full resize-y rounded-xl border border-line bg-surface p-3.5 text-[14px] leading-relaxed text-ink shadow-sm outline-none transition-colors focus:border-mint focus:ring-4 focus:ring-mint/10"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label={`${TYPE_LABEL[type]} · ${CHANNEL_LABEL[channel]} 그룹 글`}
        />
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            className={btn}
            disabled={busy || text === group.text}
            onClick={() =>
              run(async () => {
                await api.editRendering(itemId, type, channel, text);
                await props.onGroupChanged();
              })
            }
          >
            저장
          </button>
          {group.status === "approved" ? (
            <span className="inline-flex items-center rounded-md bg-mint-soft px-2.5 py-1 text-[12px] font-medium text-mint">
              승인됨 ✓
            </span>
          ) : (
            <button
              className={btnPrimary}
              disabled={busy || text !== group.text}
              title={text !== group.text ? "편집 내용을 먼저 저장하세요" : undefined}
              onClick={() =>
                run(async () => {
                  await api.approveRendering(itemId, type, channel);
                  await props.onGroupChanged();
                })
              }
            >
              승인 ✓
            </button>
          )}
          <button className={btn} onClick={() => copy("group", pasteText())} title="붙여넣기용 텍스트를 복사합니다">
            {copied === "group" ? "복사됨 ✓" : "복사"}
          </button>
        </div>

        {warnings.length > 0 && (
          <ul className="mt-2.5 space-y-1 rounded-lg border border-amber-ink/20 bg-amber-soft px-3 py-2 text-[12px] leading-relaxed text-amber-ink">
            {warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
        )}
      </div>

      <ul className="border-t border-line">
        {rows.map((row) => (
          <Row
            key={row.outletId}
            row={row}
            group={group}
            itemId={itemId}
            busy={busy}
            hovered={props.hovered}
            onHover={props.onHover}
            open={!!open[row.outletId] || (row.forked && open[row.outletId] !== false)}
            onToggle={() =>
              setOpen((p) => ({ ...p, [row.outletId]: !(p[row.outletId] || (row.forked && p[row.outletId] !== false)) }))
            }
            draft={drafts[row.outletId] ?? row.text}
            onDraft={(v) => setDrafts((p) => ({ ...p, [row.outletId]: v }))}
            copied={copied}
            // A fork has no emitted spelling of its own — the emissions route reads the stored
            // group rendering — so its own text is copied verbatim.
            onCopy={() => copy(row.outletId, row.forked ? row.text : pasteText())}
            onDrop={() => setAdded((p) => p.filter((id) => id !== row.outletId))}
            onSettle={() => settle(row.outletId)}
            onBoard={props.onBoard}
            run={run}
          />
        ))}
        {rows.length === 0 && (
          <li className="px-4 py-3 text-[12px] text-faint">이 타입을 받는 방이 아직 없습니다. 아래에서 추가하세요.</li>
        )}
      </ul>

      <div className="rounded-b-xl border-t border-line bg-surface px-4 py-2.5">
        {addable.length === 0 ? (
          <span className="text-[12px] text-faint">이 채널의 모든 방이 이미 올라와 있습니다.</span>
        ) : (
          <>
            <button
              className="text-[12px] font-medium text-muted transition-colors hover:text-ink"
              onClick={() => setPicking((p) => !p)}
            >
              {picking ? "− 닫기" : "+ 다른 방 추가"}
            </button>
            {picking && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {addable.map((id) => (
                  <button
                    key={id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink transition-colors hover:bg-surface"
                    onClick={() => {
                      setAdded((p) => [...p, id]);
                      setPicking(false);
                    }}
                  >
                    {outletLabel(id)}
                    <span className="text-[11px] text-faint">{OUTLET_DELIVERY[id] === "auto" ? "자동" : "수동"}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function Row(props: {
  row: ViewRow;
  group: BoardGroup;
  itemId: string;
  busy: boolean;
  hovered: string | null;
  onHover: (outletId: string | null) => void;
  open: boolean;
  onToggle: () => void;
  draft: string;
  onDraft: (value: string) => void;
  copied: string | null;
  onCopy: () => void;
  onDrop: () => void;
  onSettle: () => void;
  onBoard: (board: BoardView) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { row, group, itemId, busy, run } = props;
  const { type } = group;
  // The row's own resolved status, never the group's: a fork left at `rendered` under an approved
  // group is exactly the row that would silently sit out a send it looks eligible for.
  const locked = row.status !== "approved";
  const sent = row.deliveryStatus === "sent";
  const delivered = row.deliveryStatus === "delivered";
  const sibling = row.siblingCount > 1;
  const highlighted = sibling && props.hovered === row.outletId;
  const strandedFork = row.forked && locked && group.status === "approved";

  const apply = (reply: { board: BoardView }) => {
    props.onSettle();
    props.onBoard(reply.board);
  };

  return (
    <li
      onMouseEnter={() => props.onHover(row.outletId)}
      onMouseLeave={() => props.onHover(null)}
      className={`border-b border-line last:border-b-0 transition-colors ${
        row.forked ? "bg-amber-soft/40 shadow-[inset_2px_0_0_var(--color-amber-ink)]" : ""
      } ${highlighted ? "bg-mint-soft/70 shadow-[inset_2px_0_0_var(--color-mint)]" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <span className="text-[13px] font-medium text-ink">{row.label}</span>
        {sibling && (
          <span
            className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted"
            title={`이 방은 이 항목에서 ${row.siblingCount}건을 받습니다`}
          >
            {row.siblingIndex}/{row.siblingCount}
          </span>
        )}
        <span className="text-[11px] text-faint">{row.delivery === "auto" ? "자동" : "수동"}</span>
        {row.pending && (
          <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] font-medium text-muted">추가됨 · 미저장</span>
        )}

        <button
          onClick={props.onToggle}
          className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
            row.forked ? "bg-amber-soft text-amber-ink" : "text-faint hover:text-ink"
          }`}
          title={row.forked ? "이 방만의 글을 펼칩니다" : "이 방만 다른 글을 씁니다"}
        >
          {row.forked ? "✎따로" : "✎ 따로 쓰기"}
        </button>

        <span className="ml-auto flex flex-wrap items-center gap-2">
          {sent ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-md bg-mint-soft px-2 py-1 text-[12px] font-medium text-mint">
                발송됨 {stamp(row.at)}
              </span>
              {row.url && (
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  보기 ↗
                </a>
              )}
            </>
          ) : delivered ? (
            <button
              className="rounded-md bg-mint-soft px-2.5 py-1 text-[12px] font-medium text-mint transition-colors hover:bg-mint-soft/70 disabled:opacity-40"
              disabled={busy}
              title="체크를 해제하면 전달 기록이 지워집니다"
              onClick={() => run(async () => apply(await api.markOutlet(itemId, type, row.outletId, false)))}
            >
              전달함 ☑ {stamp(row.at)}
            </button>
          ) : locked ? (
            <button
              className={btn}
              disabled
              title={
                strandedFork
                  ? "이 방은 따로 쓴 글이 아직 승인 전입니다 — 그룹을 승인해도 발송되지 않습니다"
                  : "먼저 글을 승인하세요"
              }
            >
              {row.delivery === "auto" ? "발송" : "전달함"} 🔒
            </button>
          ) : row.delivery === "auto" ? (
            <button
              className={btnDanger}
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`${row.label}에 실제로 발송합니다.\n되돌릴 수 없습니다. 계속할까요?`)) return;
                void run(async () => apply(await api.sendOutlet(itemId, type, row.outletId)));
              }}
            >
              발송
            </button>
          ) : (
            <>
              <button className={btn} onClick={() => props.onCopy()}>
                {props.copied === row.outletId ? "복사됨 ✓" : "복사"}
              </button>
              <button
                className={btn}
                disabled={busy}
                onClick={() => run(async () => apply(await api.markOutlet(itemId, type, row.outletId, true)))}
              >
                전달함 ☐
              </button>
            </>
          )}
          {row.pending && !row.deliveryStatus && (
            <button className="text-[12px] text-faint transition-colors hover:text-ink" onClick={props.onDrop} title="이 행을 목록에서 뺍니다">
              ✕
            </button>
          )}
        </span>
      </div>

      {strandedFork && (
        <p className="px-4 pb-2 text-[11px] font-medium text-amber-ink">
          ⚠ 그룹은 승인됐지만 이 방의 글은 아직 검수 전입니다 — 그룹을 발송해도 이 방은 빠집니다.
        </p>
      )}

      {props.open && (
        <div className="px-4 pb-3">
          <textarea
            className="min-h-32 w-full resize-y rounded-lg border border-line bg-surface p-3 text-[13px] leading-relaxed text-ink outline-none transition-colors focus:border-mint focus:ring-4 focus:ring-mint/10"
            value={props.draft}
            onChange={(e) => props.onDraft(e.target.value)}
            spellCheck={false}
            aria-label={`${row.label} 전용 글`}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              className={btn}
              disabled={busy || props.draft.trim() === "" || props.draft === row.text}
              onClick={() => run(async () => apply(await api.editOutlet(itemId, type, row.outletId, props.draft)))}
            >
              저장
            </button>
            {row.forked &&
              (row.status === "approved" ? (
                <span className="inline-flex items-center rounded-md bg-mint-soft px-2.5 py-1 text-[12px] font-medium text-mint">
                  승인됨 ✓
                </span>
              ) : (
                <button
                  className={btnPrimary}
                  disabled={busy || props.draft !== row.text}
                  title={props.draft !== row.text ? "편집 내용을 먼저 저장하세요" : undefined}
                  onClick={() => run(async () => apply(await api.approveOutlet(itemId, type, row.outletId)))}
                >
                  승인 ✓
                </button>
              ))}
            {row.forked && (
              <button
                className={btn}
                disabled={busy}
                title="이 방만의 글을 지우고 그룹 글과 그룹 승인을 따릅니다"
                onClick={() => run(async () => apply(await api.revertOutlet(itemId, type, row.outletId)))}
              >
                그룹 글로 되돌리기
              </button>
            )}
            {!row.forked && <span className="text-[11px] text-faint">저장하면 이 방만 따로 검수·발송합니다.</span>}
          </div>
        </div>
      )}
    </li>
  );
}
