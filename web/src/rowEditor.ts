import type { BoardRow } from "./types";

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
