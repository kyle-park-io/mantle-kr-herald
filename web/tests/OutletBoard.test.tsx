// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutletBoard } from "../src/components/OutletBoard";
import type { BoardView, HeadroomView } from "../src/types";

/**
 * `authEpoch` regression coverage — the client half of the review's finding that `OutletBoard`'s
 * `reload()` and `loadQuota()` effects were mount-only. `RenderingsView` keys `OutletBoard` by
 * `itemId`, so switching items already remounts it; what nothing covered is a re-auth on the SAME
 * item — the reachable case is a session lapsing while the reviewer is on this exact screen (or a
 * cold-start login landing straight on it), which does not remount `OutletBoard` at all. Without
 * `authEpoch` threaded into both effects, `board` and `headroom` would sit on whatever they last
 * managed to fetch (`null`/stale) until the reviewer manually re-selected the item.
 *
 * An empty `groups` board keeps this test off `OutletCard` (and its own network calls) entirely —
 * `OutletBoard` renders its "아직 렌더링이 없습니다" message instead, which is enough to prove `reload`
 * and `loadQuota` re-ran without dragging in a second component's fetches.
 */

const emptyBoard = (itemId: string): BoardView => ({ itemId, groups: [], unconverted: [] });

function stubFetch(board: () => BoardView, headroom: () => HeadroomView) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/board")) return new Response(JSON.stringify(board()), { status: 200 });
    if (url.endsWith("/api/typefully/quota")) return new Response(JSON.stringify(headroom()), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OutletBoard's authEpoch-triggered refetch", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("retries reload() and loadQuota() when authEpoch changes, without remounting", async () => {
    let boardCalls = 0;
    let quotaCalls = 0;
    const fetchMock = stubFetch(
      () => {
        boardCalls += 1;
        return emptyBoard("2026-07-30-a");
      },
      () => {
        quotaCalls += 1;
        return { headroom: { available: 3, used: 1, remaining: 4, inFlight: 0, resetsAt: "2026-08-01" } };
      },
    );

    const { rerender } = render(
      <OutletBoard
        itemId="2026-07-30-a"
        convertedByType={{}}
        onGroupChanged={async () => {}}
        onDirtyChange={() => {}}
        authEpoch={0}
        sendsEnabled={true}
        conversionEnabled={true}
      />,
    );

    await waitFor(() => expect(boardCalls).toBe(1));
    await waitFor(() => expect(quotaCalls).toBe(1));
    await screen.findByText(/아직 렌더링이 없습니다/);

    // Same instance, same itemId — only authEpoch changes, standing in for a re-auth that happened
    // without the reviewer switching items (so `RenderingsView`'s `key={itemId}` never remounts this
    // component).
    rerender(
      <OutletBoard
        itemId="2026-07-30-a"
        convertedByType={{}}
        onGroupChanged={async () => {}}
        onDirtyChange={() => {}}
        authEpoch={1}
        sendsEnabled={true}
        conversionEnabled={true}
      />,
    );

    await waitFor(() => expect(boardCalls).toBe(2));
    await waitFor(() => expect(quotaCalls).toBe(2));
    // Board fetches went through the item's own board route; quota through the account-wide one —
    // proof both effects actually re-ran, not just one of them.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/board"))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/typefully/quota"))).toHaveLength(2);
  });
});

/**
 * `[변환 준비]` writes a worksheet for the local agent to fill in, so `createDeps.ts` builds
 * `prepareConversionRun` only for `routes: "local"` and `handleApi` answers 404 on the hosted route
 * set. Nothing told the board that. The button's only disabled condition is "no type ticked", so on
 * the hosted deployment an operator ticks a type, gets an enabled button, clicks it, and reads a bare
 * `not found` in the error bar — the API's own English, for a button that was never going to work
 * there. `conversionEnabled` mirrors `StatusView`'s field the same way `sendsEnabled` already does.
 */
describe("OutletBoard's [변환 준비] where the deployment cannot convert", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const unconvertedBoard = (): BoardView => ({ itemId: "2026-07-30-a", groups: [], unconverted: ["explainer"] });
  const quota = (): HeadroomView => ({
    headroom: { available: 3, used: 1, remaining: 4, inFlight: 0, resetsAt: "2026-08-01" },
  });

  function renderBoard(conversionEnabled: boolean) {
    stubFetch(unconvertedBoard, quota);
    return render(
      <OutletBoard
        itemId="2026-07-30-a"
        convertedByType={{}}
        onGroupChanged={async () => {}}
        onDirtyChange={() => {}}
        authEpoch={0}
        sendsEnabled={true}
        conversionEnabled={conversionEnabled}
      />,
    );
  }

  it("offers no way to trigger a worksheet when conversion is not available", async () => {
    renderBoard(false);

    // The unconverted types are still worth stating — they are true on this deployment too, and the
    // operator needs to know the item is incomplete. What must not be there is the action.
    await screen.findByText(/아직 변환 안 됨/);
    expect(screen.queryByRole("button", { name: "변환 준비" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("still offers it where conversion is available", async () => {
    renderBoard(true);

    await screen.findByText(/아직 변환 안 됨/);
    expect(screen.getByRole("button", { name: "변환 준비" })).toBeTruthy();
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });
});
