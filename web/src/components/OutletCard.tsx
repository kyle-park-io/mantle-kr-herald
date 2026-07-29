import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { btn, btnApproved, btnApprovedHover, btnApprovedRest, btnDanger, btnPrimary } from "../buttonStyles";
import { reformatMessage } from "../reformatMessage";
import { rowEditorGate } from "../rowEditor";
import {
  CHANNEL_FORMAT_NOTE,
  CHANNEL_LABEL,
  CHANNEL_RENDERS_BOLD,
  DESTINATION_LABEL,
  OUTLET_DELIVERY,
  PASTE_DESTINATION,
  SEND_BLOCK_REASON,
  TYPE_LABEL,
  outletLabel,
  type BoardGroup,
  type BoardRow,
  type BoardView,
  type Destination,
  type Emissions,
  type SendReply,
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

/**
 * ISO (UTC) → `07. 29. 06:20` in the reviewer's own zone. Slicing the ISO string instead would
 * print UTC as if it were local — nine hours and one calendar day off in KST, on a ledger whose
 * entire job is "did this go out, and when".
 */
const stamp = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
};
/** The same instant, spelled out — the row is narrow, the tooltip does not have to be. */
const stampFull = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString("ko-KR");
};

const SAVE_FIRST = "편집 내용을 먼저 저장하세요";
const APPROVED_LOCK = "승인 상태에서는 편집할 수 없습니다. 먼저 승인을 취소하세요.";

/** The `_paste` segments of an emission set, or `null` when they have not loaded. */
const pasteSegments = (em: Emissions | undefined, channel: BoardGroup["channel"]): string[] | null =>
  em?.[PASTE_DESTINATION[channel]]?.segments.map((s) => s.text) ?? null;

export function OutletCard(props: {
  itemId: string;
  group: BoardGroup;
  /** The joined source context for this (itemId, type) — `변환 원문`; "" when there is none. */
  convertedText: string;
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
  const groupApproved = group.status === "approved";

  const [text, setText] = useState(group.text);
  const [busy, setBusy] = useState(false);
  /**
   * Spellings keyed by outletId (`""` is the group's own text), stamped with the `emitSig` they
   * were fetched for. The stamp is what makes them safe to copy: without it, a save clears `dirty`
   * as soon as it returns while these still hold the pre-save spelling, and [복사] hands over text
   * one round trip old.
   */
  const [emissions, setEmissions] = useState<{ sig: string; byOutlet: Record<string, Emissions> }>({
    sig: "",
    byOutlet: {},
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);

  useEffect(() => setText(group.text), [group.text]);

  /**
   * Every text this card can emit, as one string: the group’s, plus each fork’s. It is both the
   * effect’s dependency and the stamp stored beside the fetched spellings, so a spelling from
   * before a save is never handed to [복사] while the refetch is still in flight.
   *
   * JSON, not a delimiter: a literal separator byte here makes the whole file binary to git, and
   * a diff nobody can read is a diff nobody reviews.
   */
  const emitSig = JSON.stringify([group.text, ...group.rows.filter((r) => r.forked).map((r) => [r.outletId, r.text])]);
  useEffect(() => {
    let live = true;
    const ids = ["", ...group.rows.filter((r) => r.forked).map((r) => r.outletId)];
    Promise.all(
      ids.map(async (id) => [id, await api.emissions(itemId, type, channel, id || undefined).catch(() => ({}))] as const),
    ).then((entries) => {
      if (live) setEmissions({ sig: emitSig, byOutlet: Object.fromEntries(entries) });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- emitSig stands in for every text read below
  }, [itemId, type, channel, emitSig]);

  function rowText(outletId: string): string {
    return group.rows.find((r) => r.outletId === outletId)?.text ?? group.text;
  }
  const draftDirty = (id: string) => drafts[id] !== undefined && drafts[id] !== rowText(id);
  /**
   * The group textarea differs from what is stored. An unsaved textarea is not what `SendChannels`
   * reads — it reads the store — so fixing a wrong figure and pressing 발송 without 저장 would post
   * the *pre-edit* copy to a live room and ledger it `sent`, which `MarkDelivery` refuses to
   * reverse. Every action that copies or delivers the group's text is gated on this.
   */
  const groupDirty = text !== group.text;
  /**
   * Card-wide, for the header badge and the navigation guard only. Row actions are gated on
   * `groupDirty || draftDirty(that row)` instead: a stray keystroke in one room's editor must not
   * freeze the rooms next to it, whose copy it cannot affect. It especially must not push the
   * operator toward that row's 저장 — on an unforked row, saving *forks* the room, which then needs
   * its own approval and silently sits out a group send.
   */
  const dirty = groupDirty || Object.keys(drafts).some(draftDirty);
  useEffect(() => {
    onDirty(cardKey, dirty);
  }, [cardKey, dirty, onDirty]);
  useEffect(() => () => onDirty(cardKey, false), [cardKey, onDirty]);

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

  /**
   * [포맷 다시] overwrites whatever `FormatVariants` last stored for this (type, channel): the
   * group's own text goes back to the plain converted text, and — unlike a text edit — the group's
   * approval is lost too, since a freshly rendered copy is never approved. Say both plainly before
   * doing it; a button that silently reverts a reviewer's approved copy is worse than no button.
   */
  const confirmReformat = (): boolean => {
    const bits = [
      `${TYPE_LABEL[type]} · ${CHANNEL_LABEL[channel]} 카드를 변환본에서 다시 생성합니다.`,
      "지금 저장된 문구는 사라지고, 새로 만든 문구로 바뀝니다.",
    ];
    if (group.status === "approved") bits.push("승인 상태도 취소됩니다 — 다시 승인해야 발송할 수 있습니다.");
    bits.push("✎ 따로 쓰기로 갈라진 방의 글은 영향받지 않습니다.", "되돌릴 수 없습니다. 계속할까요?");
    return window.confirm(bits.join("\n"));
  };

  /**
   * Drop a row's draft so the next render re-reads what the server stored. `collapse` closes the
   * editor with an explicit `false` rather than by deleting the key — a forked row defaults to
   * open, so deleting it would spring the editor straight back open.
   */
  const settle = (outletId: string, collapse = false) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[outletId];
      return next;
    });
    if (collapse) setOpen((prev) => ({ ...prev, [outletId]: false }));
  };

  const copy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  // Spellings fetched for a different text are not this card's spellings. Treating them as absent
  // disables [복사] for the round trip rather than handing over yesterday's bytes.
  const spellings = emissions.sig === emitSig ? emissions.byOutlet : {};
  const groupPaste = pasteSegments(spellings[""], channel);
  const warnings = (Object.keys(spellings[""] ?? {}) as Destination[]).flatMap((d) =>
    (spellings[""]?.[d]?.warnings ?? []).map((w) => `${DESTINATION_LABEL[d]} — ${w}`),
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
        <span className="rounded-md border border-line bg-bg px-2 py-0.5 text-[13px] font-medium text-ink">
          {TYPE_LABEL[type]} · {CHANNEL_LABEL[channel]}
        </span>
        <RenderingChip status={group.status} />
        {dirty && (
          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-amber-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-ink" />
            편집 중 · 저장 전
          </span>
        )}
        <button
          className={btnDanger}
          // Gated on `groupDirty` like every other action that reads or replaces the group's text
          // (저장/승인/복사): `onGroupChanged()` below reloads the board, `group.text` changes, and
          // the effect at the top of this component overwrites the textarea from it — an unsaved
          // draft would be discarded with no more warning than the confirm's "지금 저장된 문구는
          // 사라지고", which only promises to describe what is already *stored*, not what is
          // sitting unsaved in the box.
          disabled={busy || groupDirty}
          title={groupDirty ? SAVE_FIRST : "변환본에서 이 카드를 다시 생성합니다 — 지금 문구와 승인 상태가 사라집니다"}
          onClick={() => {
            if (!confirmReformat()) return;
            void run(async () => {
              const result = await api.formatItem(itemId, [type], [channel]);
              await props.onGroupChanged();
              // `rendered === 0` (variant not approved) and "regenerated with no warnings" both
              // return `{warnings: []}` — reformatMessage tells them apart so the operator is never
              // left assuming a silent success when nothing actually happened.
              const message = reformatMessage(result, TYPE_LABEL[type]);
              if (message) onError(message);
            });
          }}
        >
          포맷 다시
        </button>
        <span className="ml-auto text-[12px] text-faint">
          {rows.filter((r) => r.deliveryStatus).length}/{rows.length}곳 완료
        </span>
      </header>

      <div className="px-4 py-3">
        <textarea
          className={`min-h-40 w-full resize-y rounded-xl border border-line p-3.5 text-[15px] leading-relaxed shadow-sm outline-none transition-colors ${
            groupApproved
              ? "cursor-default bg-bg text-muted"
              : "bg-surface text-ink focus:border-mint focus:ring-4 focus:ring-mint/10"
          }`}
          // Approved copy is locked, exactly as in 1차. Editing it would silently drop the card back
          // to `rendered` — the rooms stop being sendable with nothing on screen having said so.
          readOnly={groupApproved}
          title={groupApproved ? APPROVED_LOCK : undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label={`${TYPE_LABEL[type]} · ${CHANNEL_LABEL[channel]} 그룹 글`}
        />
        {/*
          The reviewer types `**볼드**` into this box, and on every channel but Telegram's bot it is
          stripped before delivery. Saying so here — beside the box, not in a doc — is the only
          place it lands before the copy is approved and sent.
        */}
        <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
          {CHANNEL_RENDERS_BOLD[channel] ? "✓ " : "· "}
          {CHANNEL_FORMAT_NOTE[channel]}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            className={btn}
            disabled={busy || !groupDirty || groupApproved}
            title={groupApproved ? APPROVED_LOCK : undefined}
            onClick={() =>
              run(async () => {
                // Adopt what the server actually stored. `toCanonical` trims and collapses blank
                // lines, so a save can legitimately return the string that was already there —
                // and waiting for `group.text` to change would then leave the card `편집 중`
                // forever, with 저장 inert and 승인 greyed until a reload.
                const saved = await api.editRendering(itemId, type, channel, text);
                setText(saved.text);
                await props.onGroupChanged();
              })
            }
          >
            저장
          </button>
          {group.status === "approved" ? (
            // Same hover-swap control as 1차: one grid cell holds both labels so the button sizes to
            // the wider and never jumps. Approval has to be withdrawable here — the editor above is
            // locked while approved, so this is the only way back to editing.
            <button
              className={btnApproved}
              disabled={busy}
              title="클릭하면 승인을 취소합니다"
              onClick={() =>
                run(async () => {
                  await api.approveRendering(itemId, type, channel, false);
                  await props.onGroupChanged();
                })
              }
            >
              <span className={btnApprovedRest}>
                승인됨 ✓
              </span>
              <span className={btnApprovedHover}>
                승인 취소
              </span>
            </button>
          ) : (
            <button
              className={btnPrimary}
              disabled={busy || groupDirty}
              title={groupDirty ? SAVE_FIRST : undefined}
              onClick={() =>
                run(async () => {
                  await api.approveRendering(itemId, type, channel);
                  await props.onGroupChanged();
                })
              }
            >
              승인하기
            </button>
          )}
          <CopyButton
            id="group"
            copied={copied}
            segments={groupPaste}
            disabledReason={groupDirty ? SAVE_FIRST : undefined}
            onCopy={(v) => copy("group", v)}
          />
        </div>

        {groupPaste && groupPaste.length > 1 && (
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            이 글은 {groupPaste.length}개로 나뉘어 올라갑니다. 한 덩어리로 붙여넣지 말고 아래 <b>목적지별 출력</b>에서
            조각별로 복사하세요.
          </p>
        )}

        {warnings.length > 0 && (
          <ul className="mt-2.5 space-y-1 rounded-lg border border-amber-ink/20 bg-amber-soft px-3 py-2 text-[13px] leading-relaxed text-amber-ink">
            {warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
        )}

        <Source convertedText={props.convertedText} />
        <DestinationPreview
          label="목적지별 출력 — 실제로 나가는 바이트"
          emissions={spellings[""] ?? {}}
          copiedPrefix="group"
          copied={copied}
          disabledReason={groupDirty ? SAVE_FIRST : undefined}
          onCopy={copy}
        />
      </div>

      <ul className="border-t border-line">
        {rows.map((row) => {
          const isOpen = !!open[row.outletId] || (row.forked && open[row.outletId] !== false);
          return (
            <Row
              key={row.outletId}
              row={row}
              group={group}
              itemId={itemId}
              busy={busy}
              // Scoped to this room: the group's text, which every unforked room sends, plus this
              // room's own unsaved draft. A keystroke in the room above must not lock this one.
              dirty={groupDirty || draftDirty(row.outletId)}
              hovered={props.hovered}
              onHover={props.onHover}
              open={isOpen}
              // Collapsing drops the draft. The editor is the only place a draft is visible, so
              // keeping one behind a closed editor is invisible state that locks the row with
              // nothing on screen to explain it.
              onToggle={() =>
                isOpen ? settle(row.outletId, true) : setOpen((p) => ({ ...p, [row.outletId]: true }))
              }
              draft={drafts[row.outletId] ?? row.text}
              onDraft={(v) => setDrafts((p) => ({ ...p, [row.outletId]: v }))}
              onCancel={() => settle(row.outletId)}
              copied={copied}
              // A forked room has its own `_paste` spelling, fetched per room; an unforked one
              // shares the group's. Never the canonical text — KakaoTalk parses no markup, so
              // `**굵게**` would land verbatim in a live room.
              segments={pasteSegments(row.forked ? spellings[row.outletId] : spellings[""], channel)}
              emissions={(row.forked ? spellings[row.outletId] : spellings[""]) ?? {}}
              onCopy={copy}
              onDrop={() => setAdded((p) => p.filter((id) => id !== row.outletId))}
              onSettle={(collapse) => settle(row.outletId, collapse)}
              onBoard={props.onBoard}
              onError={onError}
              run={run}
            />
          );
        })}
        {rows.length === 0 && (
          <li className="px-4 py-3 text-[13px] text-faint">이 타입을 받는 방이 아직 없습니다. 아래에서 추가하세요.</li>
        )}
      </ul>

      <div className="rounded-b-xl border-t border-line bg-surface px-4 py-2.5">
        {addable.length === 0 ? (
          <span className="text-[13px] text-faint">이 채널의 모든 방이 이미 올라와 있습니다.</span>
        ) : (
          <>
            <button
              className="text-[13px] font-medium text-muted transition-colors hover:text-ink"
              onClick={() => setPicking((p) => !p)}
            >
              {picking ? "− 닫기" : "+ 다른 방 추가"}
            </button>
            {picking && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {addable.map((id) => (
                  <button
                    key={id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink transition-colors hover:bg-surface"
                    onClick={() => {
                      setAdded((p) => [...p, id]);
                      setPicking(false);
                    }}
                  >
                    {outletLabel(id)}
                    <span className="text-[12px] text-faint">{OUTLET_DELIVERY[id] === "auto" ? "자동" : "수동"}</span>
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

/**
 * [복사] for one piece of copy. Disabled rather than silently falling back to the canonical text
 * when the spelling has not loaded — the fallback is what puts `**굵게**` in a live room.
 */
function CopyButton(props: {
  id: string;
  copied: string | null;
  segments: string[] | null;
  disabledReason?: string;
  onCopy: (value: string) => void;
}) {
  const many = (props.segments?.length ?? 0) > 1;
  const reason = props.disabledReason ?? (props.segments ? undefined : "붙여넣기용 텍스트를 아직 불러오지 못했습니다");
  return (
    <button
      className={btn}
      disabled={!!reason}
      title={reason ?? "붙여넣기용 텍스트를 복사합니다"}
      onClick={() => props.segments && props.onCopy(props.segments.join("\n\n"))}
    >
      {props.copied === props.id ? "복사됨 ✓" : many ? `전체 복사 (${props.segments!.length})` : "복사"}
    </button>
  );
}

/** `변환 원문` — what the copy was written from. Collapsed, because the board is a delivery screen. */
function Source({ convertedText }: { convertedText: string }) {
  return (
    <details className="mt-3 rounded-lg border border-line bg-bg px-3 py-2">
      <summary className="cursor-pointer text-[13px] font-medium text-muted marker:text-faint">
        변환 원문 · converted
      </summary>
      {convertedText ? (
        <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap text-[14px] leading-relaxed text-muted">
          {convertedText}
        </div>
      ) : (
        <p className="mt-2 text-[13px] leading-relaxed text-faint">
          이 타입의 변환 원문이 없습니다. <code className="font-mono">pnpm convert:save</code> 로 저장된 변환본이 있어야
          여기에 표시됩니다.
        </p>
      )}
    </details>
  );
}

/**
 * The bytes each destination actually receives — `telegram_bot`'s HTML, Typefully's thread — with
 * per-segment lengths and per-segment copy. The board is the last screen before an irreversible
 * post, so this cannot live only on a screen the reviewer no longer visits.
 */
function DestinationPreview(props: {
  label: string;
  emissions: Emissions;
  copiedPrefix: string;
  copied: string | null;
  disabledReason?: string;
  onCopy: (key: string, value: string) => void;
}) {
  const keys = Object.keys(props.emissions) as Destination[];
  const [tab, setTab] = useState<Destination | null>(null);
  const active = tab && props.emissions[tab] ? tab : (keys[0] ?? null);
  if (!active) return null;
  const result = props.emissions[active]!;

  return (
    <details className="mt-2 rounded-lg border border-line bg-bg px-3 py-2">
      <summary className="cursor-pointer text-[13px] font-medium text-muted marker:text-faint">{props.label}</summary>
      <div className="mt-2">
        <div className="mb-2 inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-surface p-0.5">
          {keys.map((d) => (
            <button
              key={d}
              onClick={() => setTab(d)}
              className={`rounded-[7px] px-2.5 py-1 text-[13px] font-medium transition-colors ${
                d === active ? "bg-bg text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {DESTINATION_LABEL[d]}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {result.segments.map((s, i) => {
            const pct = s.limit > 0 ? Math.min(100, Math.round((s.length / s.limit) * 100)) : 0;
            const key = `${props.copiedPrefix}:${active}:${i}`;
            return (
              <div key={i} className="rounded-lg border border-line bg-surface p-2.5">
                <div className="mb-1.5 flex items-center gap-2.5 text-[13px]">
                  {result.segments.length > 1 && (
                    <span className="font-medium text-muted">
                      {s.label ?? `${i + 1}/${result.segments.length}`}
                    </span>
                  )}
                  <div className="flex items-center gap-1.5">
                    <span className={`font-mono tabular-nums ${s.overLimit ? "font-semibold text-red-600" : "text-faint"}`}>
                      {s.length}/{s.limit}
                    </span>
                    <span className="h-1 w-14 overflow-hidden rounded-full bg-line">
                      <span
                        className={`block h-full rounded-full ${s.overLimit ? "bg-red-500" : "bg-mint"}`}
                        style={{ width: `${s.overLimit ? 100 : pct}%` }}
                      />
                    </span>
                  </div>
                  <button
                    className={`ml-auto ${btn}`}
                    disabled={!!props.disabledReason}
                    title={props.disabledReason}
                    onClick={() => props.onCopy(key, s.text)}
                  >
                    {props.copied === key ? "복사됨 ✓" : "복사"}
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[13px] leading-relaxed text-ink/80">
                  {s.text}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function Row(props: {
  row: ViewRow;
  group: BoardGroup;
  itemId: string;
  busy: boolean;
  dirty: boolean;
  hovered: string | null;
  onHover: (outletId: string | null) => void;
  open: boolean;
  onToggle: () => void;
  draft: string;
  onDraft: (value: string) => void;
  /** Throw the draft away without saving — the only exit that does not fork the room. */
  onCancel: () => void;
  copied: string | null;
  segments: string[] | null;
  emissions: Emissions;
  onCopy: (key: string, value: string) => void;
  onDrop: () => void;
  onSettle: (collapse?: boolean) => void;
  onBoard: (board: BoardView) => void;
  onError: (message: string | null) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { row, group, itemId, busy, dirty, run } = props;
  const { type } = group;
  // Straight from the server's `sendBlock` — the same predicate `SendChannels` enforces, so this
  // button is locked exactly when a send would refuse. It covers the row's own approval (never the
  // group's: a fork left at `rendered` under an approved group would otherwise silently sit out a
  // send it looks eligible for) *and* the state of the 1차 translation it descends from.
  const locked = row.block !== undefined;
  const sent = row.deliveryStatus === "sent";
  const delivered = row.deliveryStatus === "delivered";
  const highlighted = props.hovered === row.outletId;
  const strandedFork = row.forked && row.block === "unapproved" && group.status === "approved";
  const blocked = busy || dirty;
  // What this room's editor may still do. A `sent` row is read-only: see `rowEditorGate`.
  const gate = rowEditorGate(row, { busy, draft: props.draft });

  const apply = (reply: { board: BoardView }, collapse = false) => {
    props.onSettle(collapse);
    props.onBoard(reply.board);
  };

  const confirmSend = (): boolean => {
    const preview = row.text.replace(/\s+/g, " ").trim();
    const shown = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;
    return window.confirm(
      `${row.label}에 실제로 발송합니다. 되돌릴 수 없습니다.\n\n보낼 글:\n${shown}\n\n계속할까요?`,
    );
  };

  return (
    <li
      // The header's room summary scrolls here by this attribute. A room can appear under several
      // cards (데브방 takes both 공지 and 해설), so the selector below picks the first — which is the
      // board's own top-to-bottom order, the same order the `n/m` badges were numbered in.
      data-outlet={row.outletId}
      onMouseEnter={() => props.onHover(row.outletId)}
      onMouseLeave={() => props.onHover(null)}
      className={`border-b border-line last:border-b-0 transition-colors ${
        row.forked ? "bg-amber-soft/40 shadow-[inset_2px_0_0_var(--color-amber-ink)]" : ""
      } ${highlighted ? "bg-mint-soft/70 shadow-[inset_2px_0_0_var(--color-mint)]" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <span className="text-[14px] font-medium text-ink">{row.label}</span>
        {row.siblingCount > 1 && (
          <span
            className="rounded bg-bg px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted"
            title={`이 방은 이 항목에서 ${row.siblingCount}건을 받습니다`}
          >
            {row.siblingIndex}/{row.siblingCount}
          </span>
        )}
        <span className="text-[12px] text-faint">{row.delivery === "auto" ? "자동" : "수동"}</span>
        {row.pending && (
          <span className="rounded bg-bg px-1.5 py-0.5 text-[11px] font-medium text-muted">추가됨 · 미저장</span>
        )}

        <button
          onClick={props.onToggle}
          className={`rounded px-1.5 py-0.5 text-[12px] font-medium transition-colors ${
            row.forked ? "bg-amber-soft text-amber-ink" : "text-faint hover:text-ink"
          }`}
          title={
            gate.readOnly
              ? "이 방에 나간 글을 봅니다 — 고칠 수 없습니다"
              : row.forked
                ? "이 방만의 글을 펼칩니다"
                : "이 방만 다른 글을 씁니다"
          }
        >
          {gate.readOnly ? (row.forked ? "✎따로 · 보기" : "글 보기") : row.forked ? "✎따로" : "✎ 따로 쓰기"}
        </button>

        <span className="ml-auto flex flex-wrap items-center gap-2">
          {sent ? (
            <>
              <span
                className="inline-flex items-center gap-1 rounded-md bg-mint-soft px-2 py-1 text-[13px] font-medium text-mint"
                title={stampFull(row.at)}
              >
                발송됨 {stamp(row.at)}
              </span>
              {row.url && (
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  보기 ↗
                </a>
              )}
            </>
          ) : delivered ? (
            <button
              className="rounded-md bg-mint-soft px-2.5 py-1 text-[13px] font-medium text-mint transition-colors hover:bg-mint-soft/70 disabled:opacity-40"
              disabled={busy}
              title={`${stampFull(row.at) ?? ""} — 체크를 해제하면 전달 기록이 지워집니다`}
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
                  : SEND_BLOCK_REASON[row.block!]
              }
            >
              {row.delivery === "auto" ? "발송" : "전달함"} · 잠김
            </button>
          ) : row.delivery === "auto" ? (
            <button
              className={btnDanger}
              disabled={blocked}
              title={dirty ? SAVE_FIRST : "실제 채널에 올립니다 — 되돌릴 수 없습니다"}
              onClick={() => {
                if (!confirmSend()) return;
                void run(async () => {
                  let reply: SendReply;
                  try {
                    reply = await api.sendOutlet(itemId, type, row.outletId);
                  } catch (e) {
                    // A refusal usually means the server already knows something this screen does
                    // not ("already delivered to this room" — someone ran `send:channels` in a
                    // terminal). Repaint from the board it sent back, or the row goes on offering
                    // 발송 for a room that has already received it.
                    if (e instanceof ApiError && e.board) props.onBoard(e.board);
                    throw e;
                  }
                  apply(reply);
                  // 200 can still carry a partial failure: something reached a live room and
                  // something did not. Saying nothing would read as a clean send.
                  if (reply.failed > 0 || reply.error)
                    props.onError(reply.error ?? `${row.label}: ${reply.failed}건 실패했습니다`);
                });
              }}
            >
              발송
            </button>
          ) : (
            <>
              <CopyButton
                id={row.outletId}
                copied={props.copied}
                segments={props.segments}
                disabledReason={dirty ? SAVE_FIRST : undefined}
                onCopy={(v) => props.onCopy(row.outletId, v)}
              />
              <button
                className={btn}
                disabled={blocked}
                title={dirty ? SAVE_FIRST : undefined}
                onClick={() => run(async () => apply(await api.markOutlet(itemId, type, row.outletId, true)))}
              >
                전달함 ☐
              </button>
            </>
          )}
          {row.pending && !row.deliveryStatus && (
            <button
              className="text-[13px] text-faint transition-colors hover:text-ink"
              onClick={props.onDrop}
              title="이 행을 목록에서 뺍니다"
            >
              ✕
            </button>
          )}
        </span>
      </div>

      {strandedFork && (
        <p className="px-4 pb-2 text-[12px] font-medium text-amber-ink">
          ⚠ 그룹은 승인됐지만 이 방의 글은 아직 검수 전입니다 — 그룹을 발송해도 이 방은 빠집니다.
        </p>
      )}

      {/*
        `unapproved` needs no line — `발송 · 잠김` already says it and `승인하기` is on screen. The
        source-level blocks are different: nothing else on this card mentions the 1차 translation, so
        a reviewer staring at approved copy under a locked button would have no idea what to fix, and
        a tooltip on a disabled button is not somewhere anyone thinks to look.
      */}
      {row.block !== undefined && row.block !== "unapproved" && !sent && (
        <p className="px-4 pb-2 text-[12px] font-medium text-amber-ink">⚠ {SEND_BLOCK_REASON[row.block]}</p>
      )}

      {props.open && (
        <div className="px-4 pb-3">
          <textarea
            className={`min-h-32 w-full resize-y rounded-lg border border-line p-3 text-[15px] leading-relaxed outline-none transition-colors ${
              gate.readOnly
                ? "cursor-default bg-bg text-muted"
                : "bg-surface text-ink focus:border-mint focus:ring-4 focus:ring-mint/10"
            }`}
            // A sent row shows the stored copy, never a local draft: if the room was sent from
            // outside this tab (e.g. `pnpm send:channels`) while an unsaved draft sat in this
            // editor, `props.draft` would repaint as "what the room received" and nothing short
            // of collapsing the editor could clear it.
            value={gate.readOnly ? row.text : props.draft}
            onChange={(e) => props.onDraft(e.target.value)}
            readOnly={gate.readOnly}
            spellCheck={false}
            aria-label={gate.readOnly ? `${row.label}에 발송된 글` : `${row.label} 전용 글`}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {gate.showSave && (
              <button
                className={btn}
                disabled={gate.saveDisabled}
                title={row.forked ? undefined : "저장하면 이 방은 그룹과 분리되어 따로 검수·발송합니다"}
                onClick={() => run(async () => apply(await api.editOutlet(itemId, type, row.outletId, props.draft)))}
              >
                저장
              </button>
            )}
            {gate.showCancel && (
              <button
                className={btn}
                disabled={busy}
                title={row.forked ? "고친 내용을 버리고 저장된 이 방 글로 되돌립니다" : "고친 내용을 버립니다 — 이 방은 그룹 글을 계속 씁니다"}
                onClick={props.onCancel}
              >
                취소
              </button>
            )}
            {/* Withdrawable until the room has actually been posted to; after that it is a record. */}
            {gate.showUnapprove ? (
              <button
                className={btnApproved}
                disabled={busy}
                title="클릭하면 이 방의 승인을 취소합니다"
                onClick={() => run(async () => apply(await api.approveOutlet(itemId, type, row.outletId, false)))}
              >
                <span className={btnApprovedRest}>
                  승인됨 ✓
                </span>
                <span className={btnApprovedHover}>
                  승인 취소
                </span>
              </button>
            ) : (
              gate.showApproved && (
                <span className="inline-flex items-center rounded-md bg-mint-soft px-2.5 py-1 text-[13px] font-medium text-mint">
                  승인됨 ✓
                </span>
              )
            )}
            {gate.showApprove && (
              <button
                className={btnPrimary}
                disabled={gate.approveDisabled}
                title={props.draft !== row.text ? SAVE_FIRST : undefined}
                onClick={() => run(async () => apply(await api.approveOutlet(itemId, type, row.outletId)))}
              >
                승인하기
              </button>
            )}
            {gate.showRevert && (
              <button
                className={btn}
                disabled={busy}
                title="이 방만의 글을 지우고 그룹 글과 그룹 승인을 따릅니다"
                onClick={() =>
                  // Collapse on the way out: the row is no longer forked, so leaving the editor
                  // open would show the group text under a row that no longer has its own.
                  run(async () => apply(await api.revertOutlet(itemId, type, row.outletId), true))
                }
              >
                그룹 글로 되돌리기
              </button>
            )}
            {gate.showForkHint && <span className="text-[12px] text-faint">저장하면 이 방만 따로 검수·발송합니다.</span>}
            {gate.showGroupApprovalHint && (
              <span className="text-[12px] text-faint">
                이 방은 그룹 승인을 따릅니다 — 고치려면 위 카드에서 승인을 취소하세요.
              </span>
            )}
            {gate.showReadOnlyLocked && (
              <span className="text-[12px] text-faint">
                이 방이 실제로 받은 글입니다 — 이미 발송되어 고칠 수 없습니다.
              </span>
            )}
            {gate.showReadOnlyStale && (
              <span className="text-[12px] text-faint">
                이 방에 나간 글입니다 — 그룹 글이 그 뒤 바뀌었을 수 있습니다.
              </span>
            )}
          </div>
          {row.forked && (
            <DestinationPreview
              label={`${row.label}에 실제로 나가는 바이트`}
              emissions={props.emissions}
              copiedPrefix={row.outletId}
              copied={props.copied}
              disabledReason={dirty ? SAVE_FIRST : undefined}
              onCopy={props.onCopy}
            />
          )}
        </div>
      )}
    </li>
  );
}
