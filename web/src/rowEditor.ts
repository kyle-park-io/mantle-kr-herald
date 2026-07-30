import type { BoardRow, BoardView, Channel, ConversionType } from "./types";

/**
 * Which story the 재발송 confirm dialog has to tell. The three shapes a resendable row can have
 * differ in what is actually KNOWN about the room, and the dialog is the last screen before an
 * irreversible click — so it may not describe one shape in another's words.
 *
 * - `queued`   — an X row whose Typefully draft has not published yet. `at` is when it was *queued*,
 *                the server cancels that draft first, and exactly one post goes up.
 * - `unlinked` — an X row the ledger records as `sent` that carries neither a draft id nor an x.com
 *                url, so nothing on this screen or on the server can say whether a post exists. The
 *                server's resend guard writes exactly this shape when it cancels a queued draft and
 *                then cannot rule out that the original published anyway (see `guardQueuedDraft`):
 *                it retires the draft id deliberately, and then tells the operator to press 재발송
 *                once more if the post never appeared. That operator lands HERE, so this branch must
 *                not greet them with "이 방에는 나간 글이 있습니다".
 *                (`awaitingPublish` is false with no url exactly when there is no draft id, so this
 *                needs no extra field from the board.)
 * - `posted`   — the ordinary case: the room holds a post, and a resend adds a second one.
 */
export type ResendKind = "queued" | "unlinked" | "posted";

export function resendKind(
  row: Pick<BoardRow, "deliveryStatus" | "awaitingPublish" | "url">,
  channel: Channel,
): ResendKind {
  if (row.awaitingPublish) return "queued";
  if (channel === "x" && row.deliveryStatus === "sent" && !row.url) return "unlinked";
  return "posted";
}

/**
 * What [게시 확인] found out about THE ROW IT WAS CLICKED ON.
 *
 * The counts the reconcile route answers with (`reconciled`/`retired`/`pending`) are ledger-wide:
 * `ReconcilePublished.run()` walks every awaiting row in both ledgers, not the one room the operator
 * clicked. Reading a per-row message off them misreports in both directions, and both are reachable
 * whenever a batch has more than one room in Typefully's queue at once — which is the normal case:
 *
 * - a SIBLING's draft was deleted (`retired > 0`) and this room is told its own post was cancelled,
 *   beside a badge that still reads `예약됨`;
 * - a SIBLING published (`reconciled > 0`) while this row did not, and "아직 게시되지 않았습니다" is
 *   withheld — the click answers with nothing at all, which reads as success.
 *
 * The row's own post-pass state is right there in the reply: every mutating route answers with the
 * rebuilt board, and the button already repaints from it. So the outcome is DERIVED from that row
 * rather than inferred from a tally — the same move as `deliveredToRoom`, one predicate instead of two
 * places guessing.
 *
 * - `published` — the row now carries an x.com url. The link is on screen; there is nothing to say.
 * - `retired`   — the draft was deleted before it published (`dropped`). This room got nothing and is
 *                 sendable again.
 * - `pending`   — still a scheduled draft. Typefully has not published it yet.
 * - `unknown`   — the row is no longer a scheduled draft this screen can speak for: it left the board,
 *                 or it lost its draft id without gaining a url (the `unlinked` shape a resend guard
 *                 writes). Rare, and only reachable when something else moved the row during the
 *                 click — so it is reported as unknown rather than dressed up as one of the three.
 */
export type ReconcileOutcome = "published" | "retired" | "pending" | "unknown";

/**
 * `type` AND `channel` both narrow the group, not just `type`: a room can appear under several cards
 * (데브방 takes 공지 and 해설), and one type can render to more than one channel. Matching on `type`
 * alone would pick the first group that happens to hold the room — a different row's fate, which is
 * the exact class of bug this function exists to remove.
 */
export function reconcileOutcome(
  board: BoardView,
  at: { type: ConversionType; channel: Channel; outletId: string },
): ReconcileOutcome {
  const group = board.groups.find((g) => g.type === at.type && g.channel === at.channel);
  const row = group?.rows.find((r) => r.outletId === at.outletId);
  if (row === undefined) return "unknown";
  if (row.deliveryStatus === "dropped") return "retired";
  if (row.awaitingPublish) return "pending";
  return row.url ? "published" : "unknown";
}

/** What a room's own editor may do, and which of its buttons exist at all. */
export interface RowEditorGate {
  /** The textarea is a record to read, not a draft to edit. */
  readOnly: boolean;
  showSave: boolean;
  saveDisabled: boolean;
  showCancel: boolean;
  showApprove: boolean;
  approveDisabled: boolean;
  /** The fork carries its own approval — a status, not an action, so a sent row still shows it. */
  showApproved: boolean;
  /** …and while it can still be withdrawn, that status doubles as the 승인 취소 button. */
  showUnapprove: boolean;
  /**
   * Approved, but the approval is the *group's* — this room has no override of its own, so there is
   * nothing here to withdraw and the editor says where the button actually is.
   */
  showGroupApprovalHint: boolean;
  /** The room already has a post, so it can be sent to again. */
  showResend: boolean;
  /**
   * …but not right now — the copy is blocked, and the server would refuse. Locked rather than
   * hidden, the same way the first send is: a button that appears and disappears as approval is
   * withdrawn and restored resizes the row under the pointer, and a control that vanishes reads as
   * a fault rather than as a rule. The reason rides along in the hover card.
   */
  resendDisabled: boolean;
  showRevert: boolean;
  /** "saving forks this room" — only worth saying while saving is still possible. */
  showForkHint: boolean;
  /**
   * The room's own override, now locked. The text on screen is that override, so "this room
   * received exactly this" is something the data backs.
   */
  showReadOnlyLocked: boolean;
  /**
   * No override of its own — the text on screen is the group's *current* text, standing in for
   * what this room received. The group textarea and re-render can still move that text after the
   * send, so the hint must not claim the room got what is showing now.
   */
  showReadOnlyStale: boolean;
}

/**
 * Decided in one place so the card cannot disagree with itself about a room.
 *
 * A row the ledger records as `sent` is the record of an irreversible post, not a draft. Its text
 * stays on screen — that is the whole point of showing it — but every action that would replace it
 * is gone: saving a new override, approving one, or deleting one all repaint the room's copy while
 * the row still reads `발송됨`, so the board would show text the room never received. The board is
 * the operator's only audit surface for a live post, and nothing else records what actually went.
 *
 * `delivered` is a different thing: a human's own claim, reversible by unticking it. Those rows stay
 * editable — the copy may not have been pasted yet.
 */
export function rowEditorGate(
  row: Pick<BoardRow, "deliveryStatus" | "forked" | "status" | "text" | "block">,
  ctx: { busy: boolean; draft: string },
): RowEditorGate {
  const sent = row.deliveryStatus === "sent";
  const changed = ctx.draft !== row.text;
  /**
   * Approved copy is locked, exactly as in 1차: withdraw the approval first, then edit.
   *
   * The alternative — letting an edit silently drop the row back to `rendered` — is what the store
   * does on its own, and it hides the one fact that matters here: this room was cleared to send and
   * no longer is. `SendChannels` reads the store, so a reviewer who typed a fix and walked away
   * would leave the room withheld with nothing on screen having said so.
   */
  const approved = row.status === "approved";
  const locked = sent || approved;
  return {
    readOnly: locked,
    showSave: !locked,
    saveDisabled: ctx.busy || ctx.draft.trim() === "" || !changed,
    showCancel: !locked && changed,
    showApprove: !sent && row.forked && !approved,
    approveDisabled: ctx.busy || changed,
    showApproved: row.forked && approved,
    showUnapprove: !sent && row.forked && approved,
    showGroupApprovalHint: !sent && !row.forked && approved,
    showResend: sent,
    resendDisabled: row.block !== undefined,
    showRevert: !sent && row.forked,
    showForkHint: !locked && !row.forked,
    showReadOnlyLocked: sent && row.forked,
    showReadOnlyStale: sent && !row.forked,
  };
}
