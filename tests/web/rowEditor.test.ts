import { describe, expect, it } from "vitest";
import { rowEditorGate, resendKind } from "../../web/src/rowEditor";
import { deliveredToRoom, type BoardRow } from "../../web/src/types";

const row = (o: Partial<BoardRow> = {}): BoardRow => ({
  outletId: "tg-dev",
  label: "맨틀 한국 데브방",
  delivery: "auto",
  forked: true,
  status: "approved",
  text: "이 방에 나간 글",
  siblingCount: 1,
  siblingIndex: 1,
  ...o,
});

/** The editor as the reviewer finds it: open, untouched, nothing in flight. */
const untouched = (r: BoardRow) => rowEditorGate(r, { busy: false, draft: r.text });

describe("rowEditorGate", () => {
  describe("a room the bot already posted to", () => {
    const sent = row({ deliveryStatus: "sent", at: "2026-07-29T01:00:00.000Z" });

    it("shows the text read-only", () => {
      expect(untouched(sent).readOnly).toBe(true);
    });

    it("offers nothing that would replace what the room received", () => {
      const gate = untouched(sent);
      expect({ save: gate.showSave, approve: gate.showApprove, revert: gate.showRevert }).toEqual({
        save: false,
        approve: false,
        revert: false,
      });
    });

    // The row is read-only, so a draft cannot legitimately differ — but the gate must not become the
    // one thing standing between a stray `onDraft` and a live-room overwrite.
    it("still offers no 저장 when a draft somehow differs from the sent text", () => {
      expect(rowEditorGate(sent, { busy: false, draft: "고쳐 쓴 글" }).showSave).toBe(false);
    });

    it("keeps 승인됨 ✓ visible — it is a status, not an action", () => {
      expect(untouched(sent).showApproved).toBe(true);
    });

    it("locks an unforked room too: forking after the send would repaint the room's copy", () => {
      const gate = untouched(row({ forked: false, deliveryStatus: "sent" }));
      expect({ readOnly: gate.readOnly, save: gate.showSave, hint: gate.showForkHint }).toEqual({
        readOnly: true,
        save: false,
        hint: false,
      });
    });

    // A forked row's stored text IS what the room received — the confident hint is true.
    it("shows the confident hint on a forked send: the text on screen is the room's own locked copy", () => {
      const gate = untouched(sent);
      expect({ locked: gate.showReadOnlyLocked, stale: gate.showReadOnlyStale }).toEqual({
        locked: true,
        stale: false,
      });
    });

    // An unforked row's displayed text is the group's *current* text, which the group textarea
    // and re-render can still move after the send — the confident hint would be a false claim.
    it("shows the hedged hint on an unforked send: the group text may have moved since", () => {
      const gate = untouched(row({ forked: false, deliveryStatus: "sent" }));
      expect({ locked: gate.showReadOnlyLocked, stale: gate.showReadOnlyStale }).toEqual({
        locked: false,
        stale: true,
      });
    });
  });

  // 전달함 is a human's own claim and can be unticked, so the copy is still a draft. Unapproved,
  // because approval locks the editor on its own — this is about delivery not locking it.
  it("leaves a hand-delivered room editable", () => {
    const gate = untouched(row({ status: "rendered", delivery: "manual", deliveryStatus: "delivered" }));
    expect({ readOnly: gate.readOnly, save: gate.showSave, revert: gate.showRevert }).toEqual({
      readOnly: false,
      save: true,
      revert: true,
    });
  });

  // Both read-only hints are send-only claims — neither belongs on a row that has not gone out.
  it("shows neither read-only hint before a send, forked or not", () => {
    expect(untouched(row()).showReadOnlyLocked).toBe(false);
    expect(untouched(row()).showReadOnlyStale).toBe(false);
    expect(untouched(row({ forked: false })).showReadOnlyLocked).toBe(false);
    expect(untouched(row({ forked: false })).showReadOnlyStale).toBe(false);
  });

  /**
   * A `dropped` row is a scheduled Typefully draft deleted before it published — nothing ever
   * reached the room. `sent` in `rowEditorGate` is derived with `=== "sent"`, which already excludes
   * `dropped` on its own, but that is exactly the kind of thing a widened union can quietly stop
   * being true of without a test noticing.
   */
  describe("a room whose scheduled post was dropped before it published", () => {
    it("reads as not yet sent: editable, offers 승인, and has no 재발송", () => {
      const gate = untouched(row({ status: "rendered", deliveryStatus: "dropped" }));
      expect({ readOnly: gate.readOnly, showApprove: gate.showApprove, showResend: gate.showResend }).toEqual({
        readOnly: false,
        showApprove: true,
        showResend: false,
      });
    });
  });

  describe("a room nothing has gone out to", () => {
    it("edits freely and can be saved once the draft differs", () => {
      const r = row({ status: "rendered" });
      expect(untouched(r).readOnly).toBe(false);
      expect(rowEditorGate(r, { busy: false, draft: "고친 글" }).saveDisabled).toBe(false);
    });

    it("cannot save an unchanged or blank draft", () => {
      const r = row({ status: "rendered" });
      expect(untouched(r).saveDisabled).toBe(true);
      expect(rowEditorGate(r, { busy: false, draft: "   " }).saveDisabled).toBe(true);
    });

    it("shows 취소 only while the draft differs", () => {
      const r = row({ status: "rendered" });
      expect(untouched(r).showCancel).toBe(false);
      expect(rowEditorGate(r, { busy: false, draft: "고친 글" }).showCancel).toBe(true);
    });

    it("offers 승인 ✓ on an unapproved fork, and refuses it while the draft is unsaved", () => {
      const r = row({ status: "rendered" });
      expect(untouched(r).showApprove).toBe(true);
      expect(untouched(r).approveDisabled).toBe(false);
      expect(rowEditorGate(r, { busy: false, draft: "고친 글" }).approveDisabled).toBe(true);
    });

    it("offers 그룹 글로 되돌리기 only to a forked room", () => {
      expect(untouched(row()).showRevert).toBe(true);
      expect(untouched(row({ forked: false })).showRevert).toBe(false);
      expect(untouched(row({ status: "rendered", forked: false })).showForkHint).toBe(true);
    });

    /**
     * Approved copy is locked, exactly as in 1차. Letting an edit through would silently drop the
     * row back to `rendered` — the room stops being sendable and nothing on screen says so.
     */
    it("locks an approved fork and offers 승인 취소 instead of 저장", () => {
      const gate = untouched(row());
      expect({ readOnly: gate.readOnly, save: gate.showSave, unapprove: gate.showUnapprove }).toEqual({
        readOnly: true,
        save: false,
        unapprove: true,
      });
      expect(gate.showApprove).toBe(false); // already approved
      expect(gate.showRevert).toBe(true); // 그룹 글로 되돌리기 still deletes the fork
    });

    /** An unforked room has no override, so there is nothing here to withdraw — say where it is. */
    it("locks an unforked room under an approved group but points at the group's button", () => {
      const gate = untouched(row({ forked: false }));
      expect({ readOnly: gate.readOnly, unapprove: gate.showUnapprove, hint: gate.showGroupApprovalHint }).toEqual({
        readOnly: true,
        unapprove: false,
        hint: true,
      });
    });

    /** A sent row is past withdrawing: 승인됨 stays as a record, with no button under it. */
    it("shows 승인됨 without 승인 취소 once the room has been posted to", () => {
      const gate = untouched(row({ deliveryStatus: "sent" }));
      expect({ approved: gate.showApproved, unapprove: gate.showUnapprove }).toEqual({
        approved: true,
        unapprove: false,
      });
    });

    it("disables both writes while a request is in flight", () => {
      const gate = rowEditorGate(row({ status: "rendered" }), { busy: true, draft: "고친 글" });
      expect({ save: gate.saveDisabled, approve: gate.approveDisabled }).toEqual({ save: true, approve: true });
    });
  });
});

/**
 * `재발송` posts again to a room that already has one. It stays on screen once a room has been
 * posted to, and is *locked* while the copy is blocked — the server would refuse, but hiding it
 * resizes the row as approval is withdrawn and restored, and a control that vanishes reads as a
 * fault rather than as a rule.
 */
describe("rowEditorGate — 재발송", () => {
  const posted = (over: Partial<BoardRow> = {}) => untouched(row({ deliveryStatus: "sent", ...over }));

  it("is offered, and enabled, on a sent room whose copy is still sendable", () => {
    expect({ show: posted().showResend, disabled: posted().resendDisabled }).toEqual({ show: true, disabled: false });
  });

  it("stays on screen but locked while the copy is blocked", () => {
    for (const block of ["unapproved", "source-unapproved", "source-changed", "source-missing"] as const) {
      const gate = posted({ block });
      expect({ show: gate.showResend, disabled: gate.resendDisabled }, `blocked by ${block}`).toEqual({
        show: true,
        disabled: true,
      });
    }
  });

  it("is absent on a room nothing has gone out to", () => {
    expect(untouched(row()).showResend).toBe(false);
    expect(untouched(row({ deliveryStatus: "delivered" })).showResend).toBe(false);
  });
});

/**
 * The dashboard's half of "already delivered" — `OutletCard` and `OutletBoard` both count a room
 * toward `{n}/{total}곳 완료` through this one predicate rather than each re-deriving it, the same
 * reason the domain keeps a single `deliveredToRoom`. Left as a bare `r.deliveryStatus` truthiness
 * check (as it was before `dropped` existed), a dropped row — a truthy string — would silently count
 * as done: the exact bug this predicate exists to prevent.
 */
describe("deliveredToRoom (web mirror)", () => {
  it("counts a sent or delivered row as done", () => {
    expect(deliveredToRoom(row({ deliveryStatus: "sent" }))).toBe(true);
    expect(deliveredToRoom(row({ deliveryStatus: "delivered" }))).toBe(true);
  });

  it("does not count a dropped row as done — nothing reached the room", () => {
    expect(deliveredToRoom(row({ deliveryStatus: "dropped" }))).toBe(false);
  });

  it("does not count a room with no delivery at all", () => {
    expect(deliveredToRoom(row())).toBe(false);
  });
});

/**
 * Which story the 재발송 confirm dialog tells. The dialog is the last screen before an irreversible
 * post, so describing one row shape in another's words is not a copy nit — it is the operator
 * approving something other than what they read.
 *
 * The shape this exists for is the one the server's resend guard invents: it cancels a queued draft,
 * cannot rule out that the original published anyway, retires the draft id so no reconcile pass can
 * quietly reopen the room, and tells the operator to press 재발송 once more if no post ever appeared.
 * That row is `sent`, no longer `awaitingPublish`, and has no url — so the second click used to land
 * on the ordinary wording ("이 방에는 …에 나간 글이 있습니다 … 하나 더 올라갑니다"), every clause of
 * which is unknown or false for it, over a timestamp that is a *scheduling* time.
 */
describe("resendKind", () => {
  it("calls a queued X draft queued — the original is cancelled and exactly one post goes up", () => {
    expect(resendKind(row({ deliveryStatus: "sent", awaitingPublish: true }), "x")).toBe("queued");
  });

  it("calls a sent X row with no draft id and no link unlinked — nothing knows whether a post exists", () => {
    expect(resendKind(row({ deliveryStatus: "sent" }), "x")).toBe("unlinked");
  });

  it("calls a reconciled X row posted — it carries the url of a post that is really there", () => {
    expect(resendKind(row({ deliveryStatus: "sent", url: "https://x.com/a/status/777" }), "x")).toBe("posted");
  });

  // Telegram publishes immediately and comes back with a t.me url, so a linkless telegram row is an
  // old row, not an unverifiable one — there is no cancel/publish race on that channel to describe.
  it("never calls a telegram row unlinked, link or no link", () => {
    expect(resendKind(row({ deliveryStatus: "sent" }), "telegram")).toBe("posted");
    expect(resendKind(row({ deliveryStatus: "sent", url: "https://t.me/x/1" }), "telegram")).toBe("posted");
  });
});
