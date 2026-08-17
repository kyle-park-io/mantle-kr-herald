import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { btn, btnApprove, btnDanger, btnDone, btnPrimary } from "../buttonStyles";
import { reconcileOutcome, rowEditorGate, resendKind } from "../rowEditor";
import { fromEditor, toEditor } from "../canonicalEditor";
import { Tip, type ConfirmRequest } from "./ConfirmDialog";
import { ApprovedButton } from "./ApprovedButton";
import { MarkerText, MediaEditNoticeSlot } from "./MarkerText";
import {
  CHANNEL_FORMAT_NOTE,
  CHANNEL_LABEL,
  CHANNEL_PIECE,
  CHANNEL_RENDERS_BOLD,
  DESTINATION_LABEL,
  OUTLET_DELIVERY,
  PASTE_DESTINATION,
  SEND_BLOCK_REASON,
  SENDS_CLOSED_MESSAGE,
  TYPE_LABEL,
  deliveredToRoom,
  kstStampFull,
  kstStampShort,
  outletLabel,
  type BoardGroup,
  type BoardRow,
  type BoardView,
  type Destination,
  type Emissions,
  type SendReply,
} from "../types";

/**
 * A room the reviewer added from "+ 다른 방 추가". It is a row on screen and nothing on the server:
 * there is no "add room" route, because a room joins a group by acquiring an override or a
 * delivery. So it stands in as an unforked row — same text, same resolved status as the group —
 * until the operator sends it, ticks it, or gives it its own text, at which point the server rows
 * it for real on every later load.
 */
type ViewRow = BoardRow & { pending?: boolean };

/**
 * Both timestamp formatters now live in `../types` (`kstStampShort`/`kstStampFull`), pinned to
 * `Asia/Seoul`. They used to be defined here and formatted in the *reviewer's own* zone, which
 * meant one instant read two ways depending on who opened the board — on a ledger whose entire job
 * is "did this go out, and when". Aliased rather than renamed at ~10 call sites so this change
 * stays a behaviour fix, readable as one line.
 */
const stamp = kstStampShort;
const stampFull = kstStampFull;

const SAVE_FIRST = "편집 내용을 먼저 저장하세요";
const APPROVED_LOCK = "승인 상태에서는 편집할 수 없습니다. 먼저 승인을 취소하세요.";

/**
 * The pin checkbox offered on a Telegram `auto` room's 발송/재발송 confirm (see `pinOffered` in
 * `Row` below). The hint names the one failure an operator would otherwise only meet AFTER the post
 * already went out — a pin failure does not fail the send (`post()`'s `reply.error` path), so
 * without this the bot's missing admin rights would surface as a surprise error on an already-live
 * post instead of something known going in.
 */
const PIN_TOGGLE = { label: "핀으로 고정하기", hint: "봇이 이 방의 관리자여야 고정할 수 있습니다." };

/** The `_paste` segments of an emission set, or `null` when they have not loaded. */
const pasteSegments = (em: Emissions | undefined, channel: BoardGroup["channel"]): string[] | null =>
  em?.[PASTE_DESTINATION[channel]]?.segments.map((s) => s.text) ?? null;

export function OutletCard(props: {
  itemId: string;
  group: BoardGroup;
  /**
   * Whether the hosted board's auto-send routes are actually open — `AppStatus.sendsEnabled`,
   * threaded down from `App.tsx` through `RenderingsView`/`OutletBoard`. `false` only while
   * `HERALD_SENDS_ENABLED` is off on a hosted deployment; `pnpm serve` always reports `true`. Locks
   * every `auto`-delivery row's [발송]/[재발송] the same way an ineligible `row.block` already does
   * (`Row` below) — the route refuses independently either way, so this is the "say why" half, not
   * the enforcement.
   */
  sendsEnabled: boolean;
  /** The joined source context for this (itemId, type) — `변환 원문`; "" when there is none. */
  convertedText: string;
  /** The room the pointer is over, board-wide — a room in two cards highlights in both. */
  hovered: string | null;
  onHover: (outletId: string | null) => void;
  /**
   * Every mutating route answers with the rebuilt board; hand it straight up. `quotaMayHaveChanged`
   * is true only from the two call sites that can actually move the Typefully publishing quota — a
   * successful send and a reconcile pass (see `post()` and the 게시 확인 handler in `Row` below) —
   * so the board's quota banner does not refetch on every 전달함 tick, save, approve or revert.
   */
  onBoard: (board: BoardView, quotaMayHaveChanged?: boolean) => void;
  /** The group text lives in the rendering store, whose routes do not answer with a board. */
  onGroupChanged: () => Promise<void>;
  onError: (message: string | null) => void;
  onDirty: (key: string, dirty: boolean) => void;
  /** Opens the board's confirm dialog — the rows raise every irreversible action through it. */
  onConfirm: (request: ConfirmRequest) => void;
}) {
  const { itemId, group, onDirty, onError } = props;
  const { type, channel } = group;
  const cardKey = `${type}:${channel}`;
  const groupApproved = group.status === "approved";

  const [text, setText] = useState(() => toEditor(group.text));
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

  useEffect(() => setText(toEditor(group.text)), [group.text]);

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
  const draftDirty = (id: string) => drafts[id] !== undefined && fromEditor(drafts[id]) !== rowText(id);
  /**
   * The group textarea differs from what is stored. An unsaved textarea is not what `SendChannels`
   * reads — it reads the store — so fixing a wrong figure and pressing 발송 without 저장 would post
   * the *pre-edit* copy to a live room and ledger it `sent`, which `MarkDelivery` refuses to
   * reverse. Every action that copies or delivers the group's text is gated on this.
   */
  const groupDirty = fromEditor(text) !== group.text;
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
  /** The pieces this card actually goes out as — what makes a thread boundary visible. */
  const groupPieces = spellings[""]?.[PASTE_DESTINATION[channel]]?.segments ?? null;
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
    <article className="relative rounded-xl border border-line bg-surface shadow-sm @container">
      {/*
        `@container` here, not on the detail pane or the board list: this card sits at full phone
        width in one shell and beside a 320px sidebar in another, and the action rows below need to
        stack on the card's own narrow box regardless of which shell put it there. `Source`'s
        `@container` further down is a separate, nested one scoped to the read-only converted-text
        pane — the `@max-sm:` below resolves against this outer container, not that one.
      */}
      {/*
        A tab hanging from the card's top edge, coloured by approval. The board is a column of
        near-identical cards, and the one thing a reviewer scans for is which of them still need
        them — a chip inline in the header reads at the same weight as everything beside it.
      */}
      <span
        className={`absolute right-5 top-0 rounded-b-md px-2.5 py-1 text-[11px] font-semibold shadow-sm ${
          groupApproved ? "bg-mint text-white" : "bg-amber-ink text-white"
        }`}
      >
        {groupApproved ? "승인" : "검수 대기"}
      </span>

      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5 pr-24">
        <span className="inline-flex shrink-0 items-center rounded-md border border-line bg-bg px-2 py-1 text-[12px] font-medium text-ink">
          {TYPE_LABEL[type]} · {CHANNEL_LABEL[channel]}
        </span>
        {/*
          The KR account's own post, as opposed to copy pushed into a room. It carries the brand in
          public and the rooms take their cue from it, so it is the one card on the board that is not
          interchangeable with its neighbours.
        */}
        {channel === "x" && (
          <span className="inline-flex shrink-0 items-center rounded-md bg-ink px-2 py-1 text-[12px] font-medium text-white">
            공식 계정
          </span>
        )}
        {dirty && (
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-ink" />
            편집 중 · 저장 전
          </span>
        )}
        <span className="ml-auto text-[12px] text-faint">
          {rows.filter(deliveredToRoom).length}/{rows.length}곳 완료
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
        {/*
          Two facts about the box above, at the one place they can still be acted on. The split is
          the load-bearing one: a boundary is *two blank lines*, which look like nothing in a
          textarea — a reviewer cannot otherwise tell a thread from one long post, or see that they
          deleted a boundary while editing.
        */}
        <div className="mt-1.5 space-y-1 text-[12px] leading-relaxed text-faint">
          {groupPieces && groupPieces.length > 1 ? (
            /*
              The boundary is *two blank lines*, which is nearly invisible next to the one blank
              line between paragraphs — so the split is named by where it actually lands. Reading
              the opening words is how a reviewer confirms the break is where they meant it, and
              how they notice one they deleted while editing.
            */
            <div className="text-ink">
              <p className="font-medium">
                {CHANNEL_PIECE[channel]} {groupPieces.length}개로 나뉘어 나갑니다 — 경계는 빈 줄 두 개입니다.
              </p>
              <ol className="mt-1 space-y-0.5">
                {groupPieces.map((piece, i) => (
                  <li key={i} className="flex gap-1.5 text-muted">
                    <span className="shrink-0 font-mono tabular-nums text-faint">
                      {i + 1}. {piece.length}자
                    </span>
                    <span className="truncate">{piece.text.replace(/\s+/g, " ").trim()}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            groupPieces && (
              <p>
                {CHANNEL_PIECE[channel]} 1개로 나갑니다 — {groupPieces[0]?.length ?? 0}자. 나누려면 빈 줄 두 개를
                넣으세요.
              </p>
            )
          )}
          <p>
            {CHANNEL_RENDERS_BOLD[channel] ? "✓ " : "· "}
            {CHANNEL_FORMAT_NOTE[channel]}
          </p>
          {/*
            The group textarea is edited character by character, and a marker starting or stopping to
            match mid-keystroke must not shift the 저장/승인하기/복사 row directly below —
            `MediaEditNoticeSlot` is what reserves that height.
          */}
          <MediaEditNoticeSlot text={fromEditor(text)} where="변환 원문" />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2 @max-sm:flex-col @max-sm:items-stretch">
          <Tip text={groupApproved ? APPROVED_LOCK : undefined}>
            <button
              className={btn}
              disabled={busy || !groupDirty || groupApproved}
              onClick={() =>
                run(async () => {
                  // Adopt what the server actually stored. `toCanonical` trims and collapses blank
                  // lines, so a save can legitimately return the string that was already there —
                  // and waiting for `group.text` to change would then leave the card `편집 중`
                  // forever, with 저장 inert and 승인 greyed until a reload.
                  const saved = await api.editRendering(itemId, type, channel, text);
                  setText(toEditor(saved.text));
                  await props.onGroupChanged();
                })
              }
            >
              저장
            </button>
          </Tip>
          {group.status === "approved" ? (
            // Same hover-swap control as 1차: one grid cell holds both labels so the button sizes to
            // the wider and never jumps. Approval has to be withdrawable here — the editor above is
            // locked while approved, so this is the only way back to editing.
            <ApprovedButton
              disabled={busy}
              onConfirm={props.onConfirm}
              onUnapprove={() =>
                run(async () => {
                  await api.approveRendering(itemId, type, channel, false);
                  await props.onGroupChanged();
                })
              }
            />
          ) : (
            <Tip text={groupDirty ? SAVE_FIRST : undefined}>
              <button
                className={btnApprove}
                disabled={busy || groupDirty}
                onClick={() =>
                  run(async () => {
                    await api.approveRendering(itemId, type, channel);
                    await props.onGroupChanged();
                  })
                }
              >
                승인하기
              </button>
            </Tip>
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
            한 덩어리로 붙여넣지 말고 아래 <b>목적지별 출력</b>에서 조각별로 복사하세요.
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
              sendsEnabled={props.sendsEnabled}
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
              draft={drafts[row.outletId] ?? toEditor(row.text)}
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
              onConfirm={props.onConfirm}
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
          <span className="text-[13px] text-faint">추가할 수 있는 방이 더 없습니다.</span>
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
    // `reason` is the `disabled` condition itself, so it cannot ride on a `title` — see `Tip`. The
    // enabled-state line still can, and stays one: it is an ordinary hint on a live button, not an
    // explanation of why the button will not respond.
    <Tip text={reason}>
      <button
        className={btn}
        disabled={!!reason}
        title={reason === undefined ? "붙여넣기용 텍스트를 복사합니다" : undefined}
        onClick={() => props.segments && props.onCopy(props.segments.join("\n\n"))}
      >
        {props.copied === props.id ? "복사됨 ✓" : many ? `전체 복사 (${props.segments!.length})` : "복사"}
      </button>
    </Tip>
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
        // No height cap / scroll here on purpose: a photo marker is normally the LAST line of the
        // converted text (`XContentSource.mediaMarkers()` appends it), so it sits near the bottom of
        // whatever box this is — and a capped `overflow-y-auto` would clip the inline preview
        // `MarkerText` expands right below the marker, right where it matters most, on nearly every
        // card. The `<details>` this sits in is already collapsed by default, so the cap was a second
        // space-saving mechanism inside a section the reviewer has deliberately expanded to read —
        // and a preview that cannot be seen is worse than a taller expanded pane.
        <div className="@container mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-muted">
          <MarkerText text={convertedText} />
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
                  {/* `ml-auto` on BOTH: whichever of the two is the flex item here has to carry it.
                      `Tip` renders `children` alone when there is no reason, and then the button is
                      that item; when a reason exists the wrapper is, and the button's own copy goes
                      inert inside it. Dropping either one moves this button off the right edge in
                      exactly one of the two states. */}
                  <Tip text={props.disabledReason} className="ml-auto" align="right">
                    <button
                      className={`ml-auto ${btn}`}
                      disabled={!!props.disabledReason}
                      onClick={() => props.onCopy(key, s.text)}
                    >
                      {props.copied === key ? "복사됨 ✓" : "복사"}
                    </button>
                  </Tip>
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
  /** See `OutletCard`'s same-named prop — this row's [발송]/[재발송] lock exactly like an ineligible
   *  `row.block` when this is `false` and the room is `auto`-delivery. */
  sendsEnabled: boolean;
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
  /** See the same-named prop on `OutletCard` above — the `quotaMayHaveChanged` contract is identical. */
  onBoard: (board: BoardView, quotaMayHaveChanged?: boolean) => void;
  onError: (message: string | null) => void;
  onConfirm: (request: ConfirmRequest) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { row, group, itemId, busy, sendsEnabled, dirty, run } = props;
  const { type } = group;
  // Straight from the server's `sendBlock` — the same predicate `SendChannels` enforces, so this
  // button is locked exactly when a send would refuse. It covers the row's own approval (never the
  // group's: a fork left at `rendered` under an approved group would otherwise silently sit out a
  // send it looks eligible for) *and* the state of the 1차 translation it descends from.
  //
  // `!sendsEnabled` only ever adds a lock for an `auto` room — a `manual` one never calls
  // `sendToOutlet` at all (전달함 just records a human's own paste), so the flag has nothing to say
  // about it. This is the visual half of "refuse at the route, not the button": the route already
  // refuses independently (`apiHandlers.ts`'s `SENDS_CLOSED_MESSAGE`), so a click that gets past this
  // lock somehow still cannot reach a live room — this only stops an operator from being told so by
  // a confirm dialog that promises an irreversible post which cannot actually happen.
  const locked = row.block !== undefined || (row.delivery === "auto" && !sendsEnabled);
  const sent = row.deliveryStatus === "sent";
  const delivered = row.deliveryStatus === "delivered";
  // Neither `sent` nor `delivered`, on purpose: the scheduled draft was deleted before it published,
  // so this room has nothing. It falls through to the same 발송/전달함 affordances as a room with no
  // deliveryStatus at all — the branches below never test for `dropped` — and only adds the note.
  const dropped = row.deliveryStatus === "dropped";
  const highlighted = props.hovered === row.outletId;
  const strandedFork = row.forked && row.block === "unapproved" && group.status === "approved";
  const blocked = busy || dirty;
  // What this room's editor may still do. A `sent` row is read-only: see `rowEditorGate`.
  const gate = rowEditorGate(row, { busy, draft: fromEditor(props.draft) });
  /**
   * What the row's own textarea actually displays, in "shown" (editor) spelling — a read-only row
   * falls back to the stored `row.text` rather than `props.draft` (see the comment beside the
   * textarea below), and anything that describes what the box is showing, notice included, has to
   * read this instead of `props.draft` unconditionally or it can describe a string the reviewer is
   * not looking at.
   */
  const shownDraft = gate.readOnly ? toEditor(row.text) : props.draft;
  /**
   * What this room actually receives, piece by piece — the confirm shows these rather than the
   * canonical text, so the operator approves the split as well as the words.
   */
  const rowPieces = props.segments ?? [row.text];

  /**
   * Only a Telegram bot can pin what it just posted. An X post is published through Typefully, with
   * nothing on this side to pin; a `manual` room has no bot in it at all, only a human pasting — and
   * in practice never reaches `askSend`/`askResend` to begin with (see the `row.delivery === "auto"`
   * branch below), so this is a second, explicit gate rather than reliance on that routing alone.
   */
  const pinOffered = group.channel === "telegram" && row.delivery === "auto";

  /**
   * `quotaMayHaveChanged` defaults to false: every other caller of `apply` (전달함, 저장, 승인,
   * 되돌리기, below) is a ledger/override mutation that never touches Typefully, and refetching the
   * quota on each of those would be a wasted call on the smallest rate-limit bucket for no reason —
   * only `post()`'s successful `x`-channel send opts in.
   */
  const apply = (reply: { board: BoardView }, collapse = false, quotaMayHaveChanged = false) => {
    props.onSettle(collapse);
    props.onBoard(reply.board, quotaMayHaveChanged);
  };

  const post = (resend: boolean, pin: boolean) =>
    run(async () => {
      let reply: SendReply;
      try {
        reply = await api.sendOutlet(itemId, type, row.outletId, { resend, pin });
      } catch (e) {
        // A refusal usually means the server already knows something this screen does not
        // ("already delivered to this room" — someone ran `send:channels` in a terminal). Repaint
        // from the board it sent back, or the row goes on offering 발송 for a room that has it.
        // Nothing reached Typefully here, so the quota did not move — no refetch.
        if (e instanceof ApiError && e.board) props.onBoard(e.board);
        throw e;
      }
      // A real post went out (or partially did). Only the `x` channel is delivered through
      // Typefully — a telegram/kakao send can never move that quota, so this stays scoped to the
      // one channel that actually can.
      apply(reply, false, group.channel === "x");
      // 200 can still carry a partial failure: something reached a live room and something did not.
      // Saying nothing would read as a clean send.
      if (reply.failed > 0 || reply.error)
        props.onError(reply.error ?? `${row.label}: ${reply.failed}건 실패했습니다`);
    });

  const askSend = () =>
    props.onConfirm({
      title: `${row.label}에 발송합니다`,
      lines: ["실제 채널에 올라갑니다. 되돌릴 수 없습니다."],
      pieces: rowPieces,
      confirmLabel: "발송",
      toggle: pinOffered ? PIN_TOGGLE : undefined,
      onConfirm: ({ toggled }) => void post(false, toggled),
    });

  /**
   * 재발송 does two entirely different things, and the dialog has to say which one.
   *
   * `showResend` is `deliveryStatus === "sent"`, which covers both — including every `awaitingPublish`
   * row, whose badge two lines above reads `예약됨`. For those the post has NOT gone out: `at` is when
   * it was *queued*, the server cancels the queued draft before re-sending (so exactly one post goes
   * up, not two), and there is no earlier link to lose because the row has no url. Describing that as
   * "글이 하나 더 올라갑니다" contradicts the row's own badge, immediately before an irreversible click.
   *
   * The queued wording also names the ways the server refuses — the original already published, the
   * cancel did not take, or the cancel could not be told apart from a publish that beat it (Typefully
   * answers the same 204 to both, so the server compares the publishing quota across the cancel).
   * All of them come back as an error *after* the confirm, and an operator who was promised a send
   * needs to have been told a refusal was possible — including the row shape the last two leave
   * behind, which looks broken and is not: `발송됨` with no link, and 게시 확인 never touching it again.
   *
   * That shape gets its OWN branch (`unlinked`), and it is not a nicety. The server's refusal ends by
   * telling the operator to press 재발송 once more if the post never appeared; the row it leaves is
   * `sent` and no longer `awaitingPublish`, so without this branch that second click would be met
   * with "이 방에는 …에 나간 글이 있습니다 … 하나 더 올라갑니다" — every clause of which is unknown or
   * false for it, over a timestamp that is a *scheduling* time. That is exactly the contradiction PR
   * #85 removed for `예약됨` rows, on the row shape the resend guard invents.
   *
   * The quota comparison is also why the queued click answers a couple of seconds slower than the
   * others: two quota reads and a settle wait, on top of the two Typefully round trips.
   */
  const askResend = () =>
    props.onConfirm({
      title: `${row.label}에 다시 발송합니다`,
      lines: {
        queued: [
          `이 방에는 ${stampFull(row.at) ?? "이미"}에 예약한 글이 있고, 아직 올라가지 않았습니다.`,
          "예약된 원본을 취소하고 새로 보냅니다 — 이 방에는 글이 하나만 올라갑니다. 취소가 제대로 됐는지 확인하느라 몇 초 걸립니다.",
          "확인하는 사이 원본이 이미 게시됐거나 예약 취소가 실패하면, 같은 글이 두 번 올라가지 않도록 발송을 멈추고 알려드립니다.",
          "취소하는 사이에 원본이 올라간 정황이 보이거나 그 여부를 확인하지 못한 경우에도 멈춥니다. 그때 이 줄은 링크 없는 발송됨으로 남고 게시 확인도 더는 손대지 않습니다 — 계정을 확인하고 실제로 안 올라갔다면 재발송을 한 번 더 누르면 그대로 나갑니다.",
        ],
        unlinked: [
          "이 방에는 X 발송 기록이 있지만 초안 번호도 링크도 남아 있지 않아, 글이 실제로 올라갔는지 이 화면에서도 서버에서도 확인할 수 없습니다.",
          "직전 재발송이 예약된 원본을 취소하면서 그 사이 게시됐는지를 가려내지 못하면 이 상태로 남습니다 — 그때 안내한 대로, 계정에 글이 없으면 지금 누르면 됩니다.",
          "그래서 이 발송은 이 방의 첫 글일 수도, 두 번째 글일 수도 있습니다. 계정을 먼저 확인하세요.",
        ],
        posted: [
          `이 방에는 ${stampFull(row.at) ?? "이미"} 나간 글이 있습니다. 그 글은 지워지지 않고, 이 방에 글이 하나 더 올라갑니다.`,
          "발송 기록은 새 발송으로 덮어써집니다. 먼저 보낸 글의 링크는 이 화면에서 사라집니다.",
        ],
      }[resendKind(row, group.channel)],
      pieces: rowPieces,
      confirmLabel: "다시 발송",
      toggle: pinOffered ? PIN_TOGGLE : undefined,
      onConfirm: ({ toggled }) => void post(true, toggled),
    });

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
        {dropped && (
          // `at` is when the post was *scheduled*, not when the draft was deleted — the tip says so
          // rather than pairing a timestamp with "취소" the way `예약됨`/재발송 pair one with a send.
          <Tip
            text={`${stampFull(row.at) ?? ""}에 예약했지만 게시되기 전에 취소되어 이 방에는 올라가지 않았습니다. 다시 보낼 수 있습니다.`}
          >
            <span className="rounded bg-amber-soft px-1.5 py-0.5 text-[11px] font-medium text-amber-ink">
              예약 취소됨
            </span>
          </Tip>
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

        <span className="ml-auto flex flex-wrap items-center gap-2 @max-sm:flex-col @max-sm:items-stretch">
          {sent ? (
            <>
              {/*
                An X send is queued with Typefully a couple of minutes out, so until the draft is
                looked up the row has no x.com link and its stamp is when it was *queued*. Calling
                that 발송됨 with a time beside it asserts something that has not happened yet.
              */}
              {row.awaitingPublish ? (
                <Tip text={`${stampFull(row.at) ?? ""}에 예약했습니다. X는 링크가 있는 글을 즉시 게시하지 않아 2분 뒤 큐를 통해 올라갑니다. [게시 확인]을 누르면 실제 주소를 가져옵니다.`}>
                  <span className="inline-flex items-center gap-1 rounded-lg bg-amber-soft px-3.5 py-1.5 text-[13px] font-medium text-amber-ink">
                    예약됨 {stamp(row.at)}
                  </span>
                </Tip>
              ) : (
                <span
                  className="inline-flex items-center gap-1 rounded-lg bg-mint-soft px-3.5 py-1.5 text-[13px] font-medium text-mint"
                  title={stampFull(row.at)}
                >
                  발송됨 {stamp(row.at)}
                </span>
              )}
              {row.awaitingPublish && (
                <button
                  className={btn}
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const res = await api.reconcile(itemId);
                      // A scheduled draft that reconcile now finds published is the moment Typefully
                      // actually counts it against the monthly quota — not when it was queued — so
                      // this is the other real trigger for a refetch, alongside a successful send.
                      // Unconditional, and ledger-wide on purpose: the quota is account-wide, so ANY
                      // row publishing in that pass moved it, not only this room's.
                      props.onBoard(res.board, true);
                      /**
                       * The message, on the other hand, is about THIS room — read off the row in the
                       * reply rather than off the pass's counts, which tally every awaiting row in
                       * both ledgers. See `reconcileOutcome` for the two ways the counts misreport a
                       * batch that had siblings in the queue.
                       */
                      const said = {
                        retired: "예약된 게시물이 게시되기 전에 취소되었습니다 — 이 방은 다시 보낼 수 있습니다.",
                        pending: "아직 게시되지 않았습니다 — 잠시 뒤 다시 눌러보세요.",
                        // Says what it does know: the row moved, the screen is current, and this
                        // button is no longer the way to find out. Guessing between "게시됨" and
                        // "아직" here is the misreport, one step quieter.
                        unknown: "이 줄이 예약 상태에서 벗어났지만 링크가 없어, 게시 여부를 이 화면에서 확인할 수 없습니다 — 줄의 상태를 확인하세요.",
                        published: undefined, // the link is on screen now; a message would just repeat it
                      }[reconcileOutcome(res.board, { type: group.type, channel: group.channel, outletId: row.outletId })];
                      if (said !== undefined) props.onError(said);
                    })
                  }
                >
                  게시 확인
                </button>
              )}
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
              {/* Only where a send would be allowed at all. Red where 발송 is mint: this one adds
                  another live post to a room that already has one, and replaces the record. */}
              {gate.showResend && (
                <Tip
                  text={
                    // A `sent` row (the only place 재발송 renders) is always an `auto` room —
                    // `sendToOutlet` is the only thing that ever sets `deliveryStatus: "sent"` — so
                    // this reads the same closed flag the button below does, no `row.delivery` check
                    // needed. Same reasoning as `locked`: the route already refuses independently,
                    // this is only what tells the operator before they click through a confirm
                    // dialog for a post that cannot go out.
                    !sendsEnabled ? SENDS_CLOSED_MESSAGE
                    : gate.resendDisabled ? SEND_BLOCK_REASON[row.block!]
                    : dirty ? SAVE_FIRST
                    // Same split as the confirm dialog above, for the same reason: on an `예약됨`
                    // row nothing has gone out yet, so "먼저 보낸 글" names a post that does not
                    // exist — and the queued original is cancelled rather than left to publish.
                    : row.awaitingPublish ? "예약된 원본을 취소하고 새로 보냅니다 — 이 방에는 글이 하나만 올라갑니다. 원본이 이미 게시됐으면 발송을 멈춥니다."
                    : "이 방에 한 번 더 보냅니다. 먼저 보낸 글은 지워지지 않습니다."
                  }
                >
                  <button
                    className={btnDanger}
                    disabled={busy || dirty || gate.resendDisabled || !sendsEnabled}
                    onClick={askResend}
                  >
                    재발송
                  </button>
                </Tip>
              )}
            </>
          ) : delivered ? (
            <Tip text={`${stampFull(row.at) ?? ""} — 누르면 전달 기록이 지워집니다. 방에 붙여넣은 글은 그대로 남습니다.`}>
              <button
                className={btnDone}
                disabled={busy}
                onClick={() => run(async () => apply(await api.markOutlet(itemId, type, row.outletId, false)))}
              >
                전달함 ☑ {stamp(row.at)}
              </button>
            </Tip>
          ) : locked ? (
            // The reason lives in a hover card, not a native `title`: a disabled button does not
            // reliably fire hover in every browser, so the wrapper carries it — and the styled
            // panel can hold a full sentence, which `title` renders as an OS tooltip nobody reads.
            <Tip
              text={
                strandedFork
                  ? "이 방은 따로 쓴 글이 아직 승인 전입니다 — 그룹을 승인해도 이 방은 빠집니다."
                  // `row.block` is `undefined` here whenever this row is locked only because sends
                  // are closed account-wide (`locked`'s own comment above) — `SEND_BLOCK_REASON`
                  // has nothing to say about that case, so it has to be checked first.
                  : row.block === undefined
                    ? SENDS_CLOSED_MESSAGE
                    : SEND_BLOCK_REASON[row.block]
              }
            >
              <button className={btn} disabled>
                {row.delivery === "auto" ? "발송" : "전달함"} · 잠김
              </button>
            </Tip>
          ) : row.delivery === "auto" ? (
            // Mint, not red: this is the row's ordinary next step, and every action on this board
            // is irreversible in the same way — colouring the expected one as a hazard just makes
            // the palette meaningless. The confirm carries the warning. 재발송 keeps the red.
            <Tip text={dirty ? SAVE_FIRST : undefined}>
              <button className={btnPrimary} disabled={blocked} onClick={askSend}>
                발송
              </button>
            </Tip>
          ) : (
            <>
              <CopyButton
                id={row.outletId}
                copied={props.copied}
                segments={props.segments}
                disabledReason={dirty ? SAVE_FIRST : undefined}
                onCopy={(v) => props.onCopy(row.outletId, v)}
              />
              <Tip text={dirty ? SAVE_FIRST : undefined}>
                <button
                  className={btn}
                  disabled={blocked}
                  onClick={() => run(async () => apply(await api.markOutlet(itemId, type, row.outletId, true)))}
                >
                  전달함 ☐
                </button>
              </Tip>
            </>
          )}
          {/*
            `!row.deliveryStatus` still means "no ledger entry at all" with `dropped` in the union: a
            room can only be `pending` (client-added, no server row yet) while `deliveryByKey` in
            `board.ts` has nothing for it — and that map is keyed on presence, not on which status —
            so a `dropped` entry already routes the room into `group.rows` server-side and it is never
            both `pending` and `dropped` at once.
          */}
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
            value={shownDraft}
            onChange={(e) => props.onDraft(e.target.value)}
            readOnly={gate.readOnly}
            spellCheck={false}
            aria-label={gate.readOnly ? `${row.label}에 발송된 글` : `${row.label} 전용 글`}
          />
          {/*
            Reads `shownDraft` — the exact same source the textarea above renders — rather than
            `props.draft` unconditionally: on a read-only row (see the comment above) the textarea
            falls back to the stored `row.text`, and a notice built from the stale draft instead would
            describe a string the reviewer is no longer looking at.
          */}
          <MediaEditNoticeSlot text={fromEditor(shownDraft)} where="변환 원문" className="mt-1.5" />
          <div className="mt-2 flex flex-wrap items-center gap-2 @max-sm:flex-col @max-sm:items-stretch">
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
              // A forked room's own approval, not the item's or the group's — the default
              // item-level copy ("검수 대기로 돌아갑니다") would be false here, so this passes its
              // own room-scoped lines. See ApprovedButton's `lines` doc comment.
              <ApprovedButton
                disabled={busy}
                onConfirm={props.onConfirm}
                lines={[`${row.label}의 승인만 취소됩니다.`, "항목이나 다른 방에는 영향이 없습니다."]}
                onUnapprove={() => run(async () => apply(await api.approveOutlet(itemId, type, row.outletId, false)))}
              />
            ) : (
              gate.showApproved && (
                <span className="inline-flex items-center rounded-md bg-mint-soft px-2.5 py-1 text-[13px] font-medium text-mint">
                  승인됨 ✓
                </span>
              )
            )}
            {gate.showApprove && (
              // The condition below is `rowEditorGate`'s own `changed`, which is half of
              // `approveDisabled` (`busy || changed`) — so this reason and the disabling are the same
              // fact, and it could never have rendered as a `title`.
              <Tip text={props.draft !== row.text ? SAVE_FIRST : undefined}>
                <button
                  className={btnApprove}
                  disabled={gate.approveDisabled}
                  onClick={() => run(async () => apply(await api.approveOutlet(itemId, type, row.outletId)))}
                >
                  승인하기
                </button>
              </Tip>
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
