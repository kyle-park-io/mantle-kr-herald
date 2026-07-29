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
  });

  // 전달함 is a human's own claim and can be unticked, so the copy is still a draft.
  it("leaves a hand-delivered room editable", () => {
    const gate = untouched(row({ delivery: "manual", deliveryStatus: "delivered" }));
    expect({ readOnly: gate.readOnly, save: gate.showSave, revert: gate.showRevert }).toEqual({
      readOnly: false,
      save: true,
      revert: true,
    });
  });

  describe("a room nothing has gone out to", () => {
    it("edits freely and can be saved once the draft differs", () => {
      const r = row();
      expect(untouched(r).readOnly).toBe(false);
      expect(rowEditorGate(r, { busy: false, draft: "고친 글" }).saveDisabled).toBe(false);
    });

    it("cannot save an unchanged or blank draft", () => {
      const r = row();
      expect(untouched(r).saveDisabled).toBe(true);
      expect(rowEditorGate(r, { busy: false, draft: "   " }).saveDisabled).toBe(true);
    });

    it("shows 취소 only while the draft differs", () => {
      const r = row();
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
      expect(untouched(row({ forked: false })).showForkHint).toBe(true);
    });

    it("disables both writes while a request is in flight", () => {
      const gate = rowEditorGate(row({ status: "rendered" }), { busy: true, draft: "고친 글" });
      expect({ save: gate.saveDisabled, approve: gate.approveDisabled }).toEqual({ save: true, approve: true });
    });
  });
});
