// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * A stand-in for `RenderingsView` with its own internal state (a mount counter, via an
 * empty-deps `useEffect`) — standing for the real component's live, unsaved edits (an
 * `OutletCard` textarea). What this proves is not the real editor's behaviour (`OutletCard.test.tsx`
 * already covers that) but whether `App`'s own hash-driven mode router would have unmounted it: the
 * counter only advances on a fresh mount, never on a re-render, so it staying at 1 across a `#login`
 * round trip is proof `RenderingsView` was never torn down.
 */
const { mountCounter } = vi.hoisted(() => ({ mountCounter: { current: 0 } }));

vi.mock("../src/components/RenderingsView", async () => {
  const { useEffect } = await import("react");
  return {
    RenderingsView: () => {
      useEffect(() => {
        mountCounter.current += 1;
      }, []);
      return <div data-testid="renderings-fake" />;
    },
  };
});

import { App } from "../src/App";

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/translations")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith("/api/status")) {
      return new Response(
        JSON.stringify({
          storageMode: "local",
          funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 },
          sync: { synced: 0, needsRepublish: 0, unpublished: 0 },
          availableTargets: ["local"],
          integrations: [],
          sheetLinks: {},
          dbEnv: "development",
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/api/publish/state")) return new Response(JSON.stringify([]), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * `Root.tsx`'s login overlay drives the hash to `#login` and back without ever unmounting `<App>` —
 * see its own comment. This is `App.tsx`'s half of that fix: the hash-driven mode router must not
 * mistake `#login` for a request to switch back to `"translations"` mode, which would unmount
 * whatever the reviewer had open in `"renderings"` mode along the way.
 */
describe("App's hash-driven mode router", () => {
  beforeEach(() => {
    mountCounter.current = 0;
    window.location.hash = "#renderings";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("does not remount RenderingsView when the hash bounces through #login and back", async () => {
    stubFetch();
    render(<App onSignOut={() => {}} authEpoch={0} />);

    await screen.findByTestId("renderings-fake");
    expect(mountCounter.current).toBe(1);

    // The session-loss bounce: `Root.tsx`'s `goToLogin()` sets this hash on any 401, including one
    // from a save the reviewer just triggered mid-edit.
    act(() => {
      window.location.hash = "#login";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(mountCounter.current).toBe(1);
    expect(screen.getByTestId("renderings-fake")).toBeTruthy();

    // A successful re-login returns to the hash the reviewer was actually on.
    act(() => {
      window.location.hash = "#renderings";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(mountCounter.current).toBe(1);
    expect(screen.getByTestId("renderings-fake")).toBeTruthy();
  });
});

/**
 * The corollary `Root.tsx`'s own doc comment on `authEpoch` explains: `<App>` mounts once and is
 * only ever hidden across a `#login` round trip, never remounted, so its mount-only data-loading
 * effect (`refresh()`/`refreshStatus()`) would never retry on its own. The far more common path
 * through that same overlay is not a mid-edit expiry — it is the first login of the day, from a
 * cold dashboard that had no session yet when `<App>` first mounted and its initial fetch 401'd.
 * `authEpoch` is how a caller (`Root.tsx`) tells `<App>` "a login just succeeded, try again" — this
 * proves the mechanism: a prop change alone, no remount, must be enough to turn an empty board into
 * a populated one.
 */
describe("App's data refetch on authEpoch", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("retries the initial fetch when authEpoch changes, without remounting", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/translations")) {
        // The cold-start case: <App> mounted before any session existed, so its first fetch 401s —
        // exactly what a real, unauthenticated GET /api/translations answers.
        return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
      }
      if (url.endsWith("/api/status")) {
        return new Response(
          JSON.stringify({
            storageMode: "local",
            funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 },
            sync: { synced: 0, needsRepublish: 0, unpublished: 0 },
            availableTargets: ["local"],
            integrations: [],
            sheetLinks: {},
            dbEnv: "development",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/publish/state")) return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<App onSignOut={() => {}} authEpoch={0} />);
    await screen.findByText("검수할 항목을 선택하세요"); // the empty-list state renders once the failed fetch settles
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/translations"))).toHaveLength(1);

    // That 401 put the driver's own word in the error banner. Asserted here so the check after the
    // login is proof the banner was *cleared*, not proof it never rendered in the first place.
    expect(screen.getByText("unauthenticated")).toBeTruthy();

    // A successful login (`Root.tsx`'s LoginPage onSubmit) now answers with real data — the same
    // component instance, same DOM, just a new authEpoch, standing in for what Root actually does.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/translations")) {
        return new Response(
          JSON.stringify([{ itemId: "x:1", source: "x", sourceText: "src", koreanText: "번역", status: "translated", translatedAt: "now" }]),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/status")) {
        return new Response(
          JSON.stringify({
            storageMode: "local",
            funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 },
            sync: { synced: 0, needsRepublish: 0, unpublished: 0 },
            availableTargets: ["local"],
            integrations: [],
            sheetLinks: {},
            dbEnv: "development",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/publish/state")) return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    rerender(<App onSignOut={() => {}} authEpoch={1} />);

    // The item that was there all along is now visible — proof the effect actually re-ran, not just
    // that the mock was swapped.
    await screen.findByText("번역");

    // And the banner the cold start left behind is gone. The refetch above succeeded, so nothing on
    // screen is failing any more; a stale "unauthenticated" would sit across the top of a working
    // board for the rest of the session, in the driver's English, telling the reviewer their signed-in
    // dashboard is not signed in.
    expect(screen.queryByText("unauthenticated")).toBeNull();
  });
});
