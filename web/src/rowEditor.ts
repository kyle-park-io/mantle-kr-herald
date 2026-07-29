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
  row: Pick<BoardRow, "deliveryStatus" | "forked" | "status" | "text">,
  ctx: { busy: boolean; draft: string },
): RowEditorGate {
  const sent = row.deliveryStatus === "sent";
  const changed = ctx.draft !== row.text;
  return {
    readOnly: sent,
    showSave: !sent,
    saveDisabled: ctx.busy || ctx.draft.trim() === "" || !changed,
    showCancel: !sent && changed,
    showApprove: !sent && row.forked && row.status !== "approved",
    approveDisabled: ctx.busy || changed,
    showApproved: row.forked && row.status === "approved",
    showRevert: !sent && row.forked,
    showForkHint: !sent && !row.forked,
    showReadOnlyLocked: sent && row.forked,
    showReadOnlyStale: sent && !row.forked,
  };
}
