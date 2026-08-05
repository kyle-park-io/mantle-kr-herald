// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog, type ConfirmRequest } from "../src/components/ConfirmDialog";

const base = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  title: "보냅니다", lines: ["되돌릴 수 없습니다."], confirmLabel: "발송", onConfirm: () => {}, ...over,
});

afterEach(cleanup);

describe("ConfirmDialog — the optional toggle", () => {
  it("renders no checkbox when the request declares no toggle", () => {
    render(<ConfirmDialog request={base()} onCancel={() => {}} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("opens unchecked and reports false when confirmed untouched", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog request={base({ toggle: { label: "핀으로 고정하기" }, onConfirm })} onCancel={() => {}} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "발송" }));
    expect(onConfirm).toHaveBeenCalledWith({ toggled: false });
  });

  it("reports true when the operator ticks it", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog request={base({ toggle: { label: "핀으로 고정하기" }, onConfirm })} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "발송" }));
    expect(onConfirm).toHaveBeenCalledWith({ toggled: true });
  });

  /** A tick left over from the previous dialog is a pin nobody decided on. */
  it("opens unchecked again for the next request", () => {
    const { rerender } = render(<ConfirmDialog request={base({ toggle: { label: "핀으로 고정하기" } })} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox"));
    rerender(<ConfirmDialog request={null} onCancel={() => {}} />);
    rerender(<ConfirmDialog request={base({ title: "다시 보냅니다", toggle: { label: "핀으로 고정하기" } })} onCancel={() => {}} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  /**
   * The board's own `onCancel` is `() => setConfirm(null)`, constructed fresh on every render of
   * `OutletBoard` — so any unrelated state update while this dialog is open (a quota refresh, an
   * in-flight board reload) hands the dialog a new function with the SAME request still open. That
   * must not read as "a new request" and silently untick a box the operator already ticked.
   */
  it("keeps a tick when only the onCancel identity changes, not the request", () => {
    const request = base({ toggle: { label: "핀으로 고정하기" } });
    const { rerender } = render(<ConfirmDialog request={request} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    rerender(<ConfirmDialog request={request} onCancel={() => {}} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });
});
