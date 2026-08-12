// @vitest-environment jsdom
//
// The clock behind the header's countdown pies, and the first `setInterval` in this frontend. Two of
// its three behaviours are invisible until they are wrong for a long time — a tab left open all
// afternoon, a component torn down by 로그아웃 — so they are pinned here rather than left to a
// reviewer noticing a stale dial.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useNow } from "../src/useNow";

const AT = (iso: string) => new Date(iso);

/** jsdom reports `visible` and offers no setter, so the hidden case has to be installed. */
const withVisibility = (state: DocumentVisibilityState, body: () => void) => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  try {
    body();
  } finally {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  }
};

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AT("2026-08-12T05:00:00.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("re-reads the clock once a minute", () => {
    const { result } = renderHook(() => useNow());
    expect(result.current.toISOString()).toBe("2026-08-12T05:00:00.000Z");

    // Advancing the fake clock IS the passage of a minute — a `setSystemTime` on top of it would
    // move the clock twice and land the assertion on 05:02.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toISOString()).toBe("2026-08-12T05:01:00.000Z");

    // And it keeps going, rather than firing once: `setInterval`, not `setTimeout`.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toISOString()).toBe("2026-08-12T05:02:00.000Z");
  });

  it("catches up the moment the tab is looked at again, without waiting for the interval", () => {
    // The case the interval alone cannot cover: browsers throttle timers in a background tab, so a
    // reviewer who works elsewhere for an hour comes back to whatever the throttled interval last
    // managed. No timer is advanced below — the refresh has to come from the event.
    const { result } = renderHook(() => useNow());

    act(() => {
      vi.setSystemTime(AT("2026-08-12T06:30:00.000Z"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.toISOString()).toBe("2026-08-12T06:30:00.000Z");
  });

  it("does not re-render on the way OUT of the tab, only on the way back in", () => {
    // `visibilitychange` fires in both directions. Reading the clock as the tab is hidden re-renders
    // the whole board to update something nobody is looking at.
    const { result } = renderHook(() => useNow());

    withVisibility("hidden", () => {
      act(() => {
        vi.setSystemTime(AT("2026-08-12T06:30:00.000Z"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
    });
    expect(result.current.toISOString()).toBe("2026-08-12T05:00:00.000Z");
  });

  it("takes both the interval and the listener with it when it goes", () => {
    // `App` is essentially never unmounted (`Root.tsx` hides it across `#login` instead), so this
    // interval is meant to live for the session — but a deliberate 로그아웃 bumps `sessionKey` and
    // does tear it down, and a leaked interval per sign-out would accumulate for as long as the tab
    // stays open on a shared team account.
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");

    const { unmount } = renderHook(() => useNow());
    const listener = added.mock.calls.find(([type]) => type === "visibilitychange")?.[1];
    expect(listener, "no visibilitychange listener was ever registered").toBeDefined();
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    // The same function object, not merely a call with the right event name — removing a different
    // closure leaves the original attached and looks identical in a diff.
    expect(removed.mock.calls.some(([type, fn]) => type === "visibilitychange" && fn === listener)).toBe(true);
  });
});
