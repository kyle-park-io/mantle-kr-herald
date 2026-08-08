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

/**
 * The 수집 stage as a stubbed `/api/status` sends it. `unknown` because a fake has no systemd to
 * ask — which is also the state the hosted dashboard is in permanently, and deliberately not
 * `no-floor`, which would have a stub asserting something alarming about a scheduler that is not
 * there. Named once because the header reads `funnel.collected.breakdown` directly: a fixture
 * without one cannot render the header at all.
 */
const NO_SCHEDULER_COLLECTED = { items: 0, rows: 0, breakdown: { total: 0, reach: { kind: "unknown" } } };

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/translations")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith("/api/status")) {
      return new Response(
        JSON.stringify({
          storageMode: "local",
          funnel: {
            collected: NO_SCHEDULER_COLLECTED,
            translated: { items: 0, rows: 0 },
            converted: { items: 0, rows: 0 },
            rendered: { items: 0, rows: 0 },
            published: { items: 0, rows: 0 },
          },
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
            funnel: {
            collected: NO_SCHEDULER_COLLECTED,
            translated: { items: 0, rows: 0 },
            converted: { items: 0, rows: 0 },
            rendered: { items: 0, rows: 0 },
            published: { items: 0, rows: 0 },
          },
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
            funnel: {
            collected: NO_SCHEDULER_COLLECTED,
            translated: { items: 0, rows: 0 },
            converted: { items: 0, rows: 0 },
            rendered: { items: 0, rows: 0 },
            published: { items: 0, rows: 0 },
          },
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

/**
 * The header funnel used to read `수집 134 → 번역 23 → 변환 10 → 렌더 13 → 발행 16`, and every one of
 * those arrows was a claim the data does not support. Past the translation stage a row stops being
 * an item — a variant is `(itemId, type)`, a rendering `(itemId, type, channel)`, a publish-ledger
 * row `(itemId, status, target)` — so the line appeared to *gain* work between 변환 and 렌더 when
 * three items had simply fanned out twice. And 발행 is not downstream of 렌더 at all: it counts the
 * translation markdown uploaded to Drive, a sibling branch off 번역, with published items that have
 * no rendering to their name.
 */
describe("App's header funnel", () => {
  /** Production on 2026-08-08: 223 collected threads, 92 of them reply-rooted and dropped before
   *  becoming items, 3 Lark items, and 20 of the resulting 134 at or after the scheduler's floor. */
  const PRODUCTION_BREAKDOWN = {
    intake: [
      { kind: "threads", count: 223 },
      { kind: "replies-dropped", op: "-", count: 92 },
      { kind: "lark", op: "+", count: 3 },
    ],
    total: 134,
    reach: { kind: "measured", inScope: 20, belowFloor: 114, floor: "2026-07-27T14:35:25.000Z" },
  };

  const renderHeader = (breakdown: unknown) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/translations")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/api/publish/state")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/api/status")) {
          return new Response(
            JSON.stringify({
              storageMode: "cloud",
              funnel: {
                collected: { items: 134, rows: 134, breakdown },
                translated: { items: 23, rows: 23 },
                converted: { items: 3, rows: 10 },
                rendered: { items: 3, rows: 13 },
                published: { items: 9, rows: 16 },
              },
              sync: { synced: 0, needsRepublish: 0, unpublished: 0 },
              availableTargets: ["local"],
              integrations: [],
              sheetLinks: {},
              dbEnv: "production",
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<App onSignOut={() => {}} authEpoch={0} />);
  };

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /**
   * A stage's own text is its own direct spans. `:scope >` rather than every descendant span,
   * because 수집 now carries a hover card *inside* it — and the point of this assertion is that the
   * strip a reviewer actually reads did not change. Scoping to direct children is what the original
   * "the separator is a sibling, not a child" comment in `App.tsx` was reaching for; anything deeper
   * would make this test fail the moment the card gained a `<span>`, which is not what it is about.
   */
  const stage = (key: string) =>
    [...screen.getByTestId(`funnel-${key}`).querySelectorAll(":scope > span")]
      .map((s) => s.textContent)
      .join(" ");

  it("names items and rows separately, and draws no arrow between stages", async () => {
    renderHeader(PRODUCTION_BREAKDOWN);
    const funnel = await screen.findByTestId("funnel");

    // Items lead — the only count comparable with the stage before. Rows follow, named as rows, and
    // only where the two differ: at 수집 and 번역 one row *is* one item, so a `건` there would be noise.
    expect(stage("collected")).toBe("수집 134");
    expect(stage("translated")).toBe("번역 23");
    expect(stage("converted")).toBe("변환 3 10건");
    expect(stage("rendered")).toBe("렌더 3 13건");
    expect(stage("published")).toBe("발행 9 16건");
    // No arrow: this pipeline branches, and a funnel is the wrong picture of it.
    expect(funnel.textContent).not.toContain("→");
  });
});

/**
 * `수집 134` was reported to a human as a backlog of 134 on 2026-08-08. `pnpm status` now answers
 * that with `223 X threads - 92 replies dropped + 3 Lark · in scope 20 · below floor 114`; the
 * header did not, and this card is where it does. It stays a card rather than four more terms on the
 * strip because the strip has no room for them, and because this dashboard already answers "the
 * number has a story" with a hover popover.
 *
 * The card is in the DOM whether or not the pointer is over it — it is CSS (`group-hover`) that
 * reveals it, exactly like the storage-mode popover beside it, and jsdom evaluates no CSS. So these
 * assert what the card *says*, which is the part that can be wrong.
 */
describe("App's 수집 breakdown card", () => {
  const statusWith = (breakdown: unknown) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/translations")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/api/publish/state")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/api/status")) {
        return new Response(
          JSON.stringify({
            storageMode: "cloud",
            funnel: {
              collected: { items: 134, rows: 134, breakdown },
              translated: { items: 23, rows: 23 },
              converted: { items: 3, rows: 10 },
              rendered: { items: 3, rows: 13 },
              published: { items: 9, rows: 16 },
            },
            sync: { synced: 0, needsRepublish: 0, unpublished: 0 },
            availableTargets: ["local"],
            integrations: [],
            sheetLinks: {},
            dbEnv: "production",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

  const INTAKE = [
    { kind: "threads", count: 223 },
    { kind: "replies-dropped", op: "-", count: 92 },
    { kind: "lark", op: "+", count: 3 },
  ];

  const card = async (breakdown: unknown) => {
    vi.stubGlobal("fetch", statusWith(breakdown));
    render(<App onSignOut={() => {}} authEpoch={0} />);
    return await screen.findByTestId("collected-breakdown");
  };

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the intake funnel, ending on the total the header is showing", async () => {
    const el = await card({
      intake: INTAKE,
      total: 134,
      reach: { kind: "measured", inScope: 20, belowFloor: 114, floor: "2026-07-27T14:35:25.000Z" },
    });
    // 223 - 92 = 131, and the header says 134. The Lark term is what stops a reader who subtracts
    // from coming up 3 short and concluding the pipeline lost items.
    expect(el.textContent).toContain("223");
    expect(el.textContent).toContain("-92");
    expect(el.textContent).toContain("+3");
    expect(el.textContent).toContain("합계");
    expect(el.textContent).toContain("134");
  });

  it("says how much of the total the scheduler can still reach, and against which floor", async () => {
    const el = await card({
      intake: INTAKE,
      total: 134,
      reach: { kind: "measured", inScope: 20, belowFloor: 114, floor: "2026-07-27T14:35:25.000Z" },
    });
    expect(el.textContent).toContain("번역 대상 20건");
    expect(el.textContent).toContain("하한 아래 114건");
    // Rendered in KST (this board is read in Korea), with the exact instant `pnpm status` prints
    // kept as the tooltip so the two can still be compared character for character.
    expect(el.textContent).toContain("2026-07-27 23:35 KST");
    expect(el.querySelector('[title="2026-07-27T14:35:25.000Z"]')).toBeTruthy();
  });

  it("raises an alarm when the unit runs with no floor at all", async () => {
    // Not a missing setting — the scheduler working the oldest posts in the archive, every tick.
    const el = await card({ intake: INTAKE, total: 134, reach: { kind: "no-floor", inScope: 134 } });
    expect(el.textContent).toContain("⚠");
    expect(el.textContent).toContain("하한 없음");
    expect(el.textContent).toContain("오래된 것부터");
  });

  /**
   * What the hosted dashboard shows on every request, forever: a Vercel function has no systemd to
   * ask, so the floor is genuinely unknowable there. The intake half is derived from the database
   * and must survive; the floor half must read as "this screen cannot see it" and must not raise the
   * alarm that belongs to the state above — those two mean opposite things.
   */
  it("says the floor cannot be read from here, without implying there is none", async () => {
    const el = await card({
      intake: INTAKE,
      total: 134,
      reach: { kind: "unknown", detail: "could not ask systemd about herald-watch.service" },
    });
    expect(el.textContent).toContain("223");
    expect(el.textContent).toContain("읽을 수 없습니다");
    expect(el.textContent).toContain("하한이 없다는 뜻이 아니라");
    expect(el.textContent).toContain("could not ask systemd about herald-watch.service");
    expect(el.textContent).not.toContain("⚠");
  });

  it("still reports the total when there is no funnel to draw", async () => {
    // No X threads at all, or two reads of the database that disagree — the server sends no terms,
    // and the card must not invent any.
    const el = await card({ total: 3, reach: { kind: "unknown" } });
    expect(el.textContent).toContain("수집 3건");
    expect(el.textContent).not.toContain("합계");
  });

  /**
   * What the hosted dashboard shows once a scheduler tick has reported. The floor is still
   * unreadable from a Vercel function — nothing about that changed — but the scheduler now writes
   * down what it ran with, so the card has a real answer instead of "cannot be seen from here".
   *
   * The ages below are computed from the *real* clock rather than a stubbed one: the card renders
   * with `new Date()`, and a fixed fixture instant would silently start reading "3주 전" the week
   * after it was written. What is asserted is the distance, which is the thing the copy is about.
   */
  const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("shows a reported floor as the scheduler's own record, with how long ago it was written", async () => {
    const el = await card({
      intake: INTAKE,
      total: 134,
      reach: {
        kind: "reported",
        inScope: 20,
        belowFloor: 114,
        reportedFloor: "2026-07-27T14:35:25.000Z",
        reportedAt: agoIso(60 * 60 * 1000),
      },
    });
    expect(el.textContent).toContain("번역 대상 20건");
    expect(el.textContent).toContain("하한 아래 114건");
    // The provenance, on the headline, so this can never be mistaken for a floor read here.
    expect(el.textContent).toContain("스케줄러 기록");
    // The age, which is the whole obligation of this state.
    expect(el.textContent).toContain("1시간 전");
    // A recent report is not an alarm — the scheduler is doing exactly what it should.
    expect(el.textContent).not.toContain("⚠");
    // The floor itself still renders in KST with the raw ISO one hover away, same as `measured`.
    expect(el.textContent).toContain("2026-07-27 23:35 KST");
  });

  it("marks a report old enough to mean the scheduler stopped", async () => {
    // Same number, three weeks later, and it must not read the same: a floor nobody has re-reported
    // since is evidence about the scheduler, not reassurance about the queue.
    const el = await card({
      intake: INTAKE,
      total: 134,
      reach: {
        kind: "reported",
        inScope: 20,
        belowFloor: 114,
        reportedFloor: "2026-07-27T14:35:25.000Z",
        reportedAt: agoIso(21 * 24 * 60 * 60 * 1000),
      },
    });
    expect(el.textContent).toContain("21일 전");
    expect(el.textContent).toContain("⚠");
    expect(el.textContent).toContain("멈췄");
  });

  it("shows the gap when the unit and the last tick disagree, without dropping either", async () => {
    // On a machine that CAN ask systemd. The headline stays the systemd answer — it is current by
    // construction — and the report rides underneath it as something to look at.
    const el = await card({
      intake: INTAKE,
      total: 134,
      reach: {
        kind: "measured",
        inScope: 20,
        belowFloor: 114,
        floor: "2026-07-27T14:35:25.000Z",
        reportedFloor: "2026-06-01T00:00:00.000Z",
        reportedAt: agoIso(3 * 60 * 60 * 1000),
      },
    });
    expect(el.textContent).toContain("번역 대상 20건");
    expect(el.textContent).toContain("2026-06-01 09:00 KST");
    expect(el.textContent).toContain("다릅니다");
    expect(el.textContent).toContain("⚠");
  });
});
