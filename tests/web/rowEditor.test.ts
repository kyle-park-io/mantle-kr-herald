import { describe, expect, it } from "vitest";
import { rowEditorGate } from "../../web/src/rowEditor";
import type { BoardRow } from "../../web/src/types";

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
