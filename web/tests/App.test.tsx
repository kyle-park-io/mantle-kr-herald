// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

/**
 * A stand-in for `IntakeView`, on the same pattern as the `RenderingsView` fake above (own mount
 * counter, `-fake` testid), even though Task 5's `IntakeView` holds no editable state of its own —
 * this proves `App`'s render branch reaches the real import and mounts it, without pulling in its
 * `api.intakePending()` network call.
 */
const { intakeMountCounter } = vi.hoisted(() => ({ intakeMountCounter: { current: 0 } }));

vi.mock("../src/components/IntakeView", async () => {
  const { useEffect } = await import("react");
  return {
    IntakeView: () => {
      useEffect(() => {
        intakeMountCounter.current += 1;
      }, []);
      return <div data-testid="intake-fake" />;
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

function stubFetch(extra: Record<string, unknown> = {}) {
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
          ...extra,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/api/publish/state")) return new Response(JSON.stringify([]), { status: 200 });
    // The re-probe route [지금 확인] calls — never read for its body (App.tsx re-reads /api/status
    // instead), so an empty probes array is enough for every test that does not click the button.
    if (url.endsWith("/api/diagnostics/live")) return new Response(JSON.stringify({ probes: [] }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * A thin wrapper over `stubFetch` for tests that only need to vary the `/api/status` body —
 * merges `extra` into it rather than duplicating the dispatch above.
 */
function stubFetchWithStatus(extra: Record<string, unknown>) {
  return stubFetch(extra);
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
 * Task 6's own half of the router: `TABS` grew a third entry (`intake`, `#intake`), and the render
 * branch went from a two-arm ternary to three explicit `{mode === "..." &&}` guards. Neither change
 * has a failure mode that shows up by reading the diff — a ternary's `else` silently becomes "every
 * other mode" once there are three, and a hash typo in `TABS` would compile fine while the tab never
 * opens. `window.location.hash` is reset in `afterEach` because both tests below set it directly
 * (one before render, one via a click), and this file's other `describe` blocks never reset it
 * themselves — left dirty, `"#intake"` would leak into whichever test runs next.
 */
describe("App's 링크 수집 tab", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("opens 링크 수집 from its hash", async () => {
    stubFetch();
    await act(async () => {
      window.location.hash = "#intake";
    });
    render(<App onSignOut={() => {}} authEpoch={0} />);
    expect(await screen.findByTestId("intake-fake")).toBeTruthy();
    expect(intakeMountCounter.current).toBe(1);
  });

  it("opens 링크 수집 from the nav, and writes #intake to the hash", async () => {
    stubFetch();
    await act(async () => {
      window.location.hash = "";
    });
    render(<App onSignOut={() => {}} authEpoch={0} />);

    fireEvent.click(screen.getByRole("button", { name: "링크 수집" }));
    expect(await screen.findByTestId("intake-fake")).toBeTruthy();
    expect(window.location.hash).toBe("#intake");
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
   * A stage's own text sits on its leaf spans — spans with no `<span>` descendant of their own.
   * Every stage's label/count used to sit directly on the stage `<div>`, but 수집's now sit two
   * levels down, inside `InfoPopover`'s own wrapping spans (the trigger, and the span around it —
   * see `InfoPopover.tsx`), so a `:scope > span` query alone would return only that outer wrapper and
   * lose the "수집"/"134" split this helper is built to keep. Walking every span and keeping only the
   * leaves finds them regardless of depth, and stays safe against the card 수집 opens: that card
   * renders only while `InfoPopover`'s `open` state is true, and no test in this block opens it, so
   * it never contributes a span here.
   *
   * Spans with no text are dropped for the same reason as before: 번역 and 렌더 lead with a countdown
   * pie, a `<span title>` (the tooltip) wrapping an SVG that carries no text at all — deliberately,
   * because an SVG `<title>` child would land in exactly the text this helper reads. That wrapper is
   * itself a leaf (the SVG has no `<span>` of its own), so without the filter it would join as `""`
   * and prepend a space to every expectation below. The filter costs nothing this test is about: a
   * pie that ever grew visible text would still appear.
   */
  const stage = (key: string) =>
    [...screen.getByTestId(`funnel-${key}`).querySelectorAll("span")]
      .filter((s) => s.querySelector("span") === null)
      .map((s) => s.textContent ?? "")
      .filter((text) => text !== "")
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

  /**
   * The two countdown pies. Each stage of this strip is a queue, and two of them are fed by a
   * systemd timer rather than by a person: `herald-watch` (`*-*-* 0/2:17:00`) lands its output in
   * 번역, and `herald-convert` — which runs convert:save and format in one tick — comes to rest in
   * 렌더. A reviewer looking at `번역 23` cannot tell whether that number is about to move or has
   * just finished moving, and the answer is knowable in the browser: the schedule is a fixed
   * calendar, so `tickSchedule.ts` derives it with no server field and no request.
   *
   * The other three stages get nothing. 수집 advances when somebody pastes a link (링크 수집) or when
   * a collection is run by hand, 변환 is a waypoint inside the same tick that produces 렌더, and 발행
   * is a person clicking a button — a countdown on any of them would be a promise nothing keeps.
   */
  it("counts down the two ticks that feed the funnel, and marks no other stage", async () => {
    renderHeader(PRODUCTION_BREAKDOWN);
    await screen.findByTestId("funnel");

    for (const [key, name] of [["translated", "번역 틱"], ["rendered", "변환 틱"]] as const) {
      const pie = within(screen.getByTestId(`funnel-${key}`)).getByRole("img");
      // The accessible name says which scheduler, not merely "a countdown" — there are two of them
      // on this strip and they run at different cadences.
      expect(pie.getAttribute("aria-label")?.startsWith(name), `${key}: ${pie.getAttribute("aria-label")}`).toBe(true);

      // The tooltip lives on a wrapping span, not on the pie: the funnel container carries its own
      // `title` (the items-vs-rows explanation) and the nearest titled ancestor is what the pointer
      // gets, so the pie needs one of its own or it inherits a sentence about row counts.
      const wrapper = pie.closest("span[title]");
      expect(wrapper, `${key}: the pie inherits the funnel's own tooltip`).toBeTruthy();
      expect(wrapper!.getAttribute("title")).toContain(name);
      expect(wrapper!.getAttribute("title")).toContain("KST");
    }

    for (const key of ["collected", "converted", "published"]) {
      expect(within(screen.getByTestId(`funnel-${key}`)).queryByRole("img"), key).toBeNull();
    }
  });

  it("adds no text to the stages it marks", async () => {
    // The constraint `App.tsx` states over the funnel and `stage()` above relies on: a stage's text is
    // exactly its own label and its own numbers. The pie is an icon plus a tooltip plus an
    // `aria-label`, and none of those are text — which is why it may not use an SVG `<title>` child,
    // the otherwise-obvious way to caption a graphic.
    renderHeader(PRODUCTION_BREAKDOWN);
    await screen.findByTestId("funnel");
    expect(screen.getByTestId("funnel-translated").textContent).toBe("번역23");
    expect(screen.getByTestId("funnel-rendered").textContent).toBe("렌더313건");
  });

  /**
   * 수집's own regression guard: its label/count spans sit two levels inside `InfoPopover`'s trigger
   * span (not direct children of `funnel-collected` the way every other stage's are — see `stage()`'s
   * own comment above), which is exactly the shape that let the stage's `gap-1.5` go missing once
   * without any test catching it (the label and count spans still concatenate to the same text either
   * way, `gap` is invisible to `textContent`, and `stage()`'s `.join(" ")` papers over it too). This
   * cannot prove the gap renders — jsdom has no layout engine, see the InfoPopover verification report
   * for the real-browser numbers — but it does pin the DOM shape a future edit could still get wrong:
   * the label and count as two live, separately-readable text nodes, not one that swallowed the other.
   */
  it("수집's own text survives being wrapped by InfoPopover's trigger", async () => {
    renderHeader(PRODUCTION_BREAKDOWN);
    await screen.findByTestId("funnel");
    expect(screen.getByTestId("funnel-collected").textContent).toBe("수집134");
  });
});

/**
 * `수집 134` was reported to a human as a backlog of 134 on 2026-08-08. `pnpm status` now answers
 * that with `223 X threads - 92 replies dropped + 3 Lark · in scope 20 · below floor 114`; the
 * header did not, and this card is where it does. It stays a card rather than four more terms on the
 * strip because the strip has no room for them, and because this dashboard already answers "the
 * number has a story" with a hover popover.
 *
 * The card renders only once its `InfoPopover` is open — open/closed is React state, not CSS, and
 * jsdom 30 implements none of the native popover API a real browser would additionally gate this on.
 * `card()` below clicks the 수집 stage's trigger (the `수집 134` text) to open it before reading, then
 * these assert what the card *says*, which is the part that can be wrong.
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
    fireEvent.click(await screen.findByText("수집")); // opens the 수집 stage's InfoPopover
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

/**
 * The chip beside the mode pill (Task 5's `livenessChip`), the hover card's key-by-key detail
 * (`livenessHeadline` + `probeLabel`), and the [지금 확인] button that re-probes and re-reads
 * `/api/status` — the chip sits on the pill itself (always in the DOM once `status` loads), but the
 * detail and the button live inside the storage-mode `InfoPopover`, which renders only while open.
 * `stubFetchWithStatus` merges a `liveness` summary into an otherwise-ordinary status body so each
 * test states only what differs.
 *
 * Every test below opens the panel first with `fireEvent.click(await screen.findByText("local"))`.
 * That click is unambiguous at the moment it runs, because the panel — whose own "현재 local 모드"
 * line repeats the word — has not rendered yet; querying for `"local"` again afterwards would not be.
 */
describe("App's liveness chip", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows no liveness chip when the last observation found everything alive", async () => {
    stubFetchWithStatus({ liveness: { observedAt: new Date().toISOString(), worst: "ok", dead: [], contacted: 7 } });
    render(<App onSignOut={() => {}} authEpoch={0} />);
    fireEvent.click(await screen.findByText("local"));
    expect(await screen.findByRole("button", { name: "지금 확인" })).toBeTruthy();
    expect(screen.queryByText(/응답 없음/)).toBeNull();
  });

  /**
   * A Telegram-only install: three probes contacted, four skipped for missing config. Before this
   * fix, `contacted` (then `total`) was `observation.probes.length`, so the hover card would have
   * printed "7개 모두 응답" here — a false green one line below the false green this whole feature
   * exists to remove. The card must report what was actually asked.
   */
  it("counts only the probes actually contacted, not every probe key this build knows about", async () => {
    stubFetchWithStatus({ liveness: { observedAt: new Date().toISOString(), worst: "ok", dead: [], contacted: 3 } });
    render(<App onSignOut={() => {}} authEpoch={0} />);
    fireEvent.click(await screen.findByText("local"));
    expect(await screen.findByText(/3개 모두 응답/)).toBeTruthy();
    expect(screen.queryByText(/7개 모두 응답/)).toBeNull();
  });

  it("shows a red chip naming the tier when a publishing credential is dead", async () => {
    stubFetchWithStatus({
      liveness: {
        observedAt: new Date().toISOString(),
        worst: "fail",
        dead: [{ key: "google_auth", tier: "publish", severity: "fail", detail: "400 invalid_grant" }],
        contacted: 7,
      },
    });
    render(<App onSignOut={() => {}} authEpoch={0} />);
    expect(await screen.findByText("⚠ 발행 키 1개 응답 없음")).toBeTruthy();
  });

  it("names the dead credential and its reason in the hover card", async () => {
    stubFetchWithStatus({
      liveness: {
        observedAt: new Date().toISOString(),
        worst: "fail",
        dead: [{ key: "google_auth", tier: "publish", severity: "fail", detail: "400 invalid_grant" }],
        contacted: 7,
      },
    });
    render(<App onSignOut={() => {}} authEpoch={0} />);
    fireEvent.click(await screen.findByText("local"));
    expect(await screen.findByText("Google 인증")).toBeTruthy();
    expect(screen.getByText("400 invalid_grant")).toBeTruthy();
  });

  it("re-probes and re-reads the status when [지금 확인] is clicked", async () => {
    const fetchMock = stubFetchWithStatus({
      liveness: { observedAt: new Date().toISOString(), worst: "ok", dead: [], contacted: 7 },
    });
    render(<App onSignOut={() => {}} authEpoch={0} />);
    fireEvent.click(await screen.findByText("local"));
    await screen.findByRole("button", { name: "지금 확인" });
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "지금 확인" }));
    // Order is the load-bearing part of this flow — the deployment must record what it observed
    // (`/api/diagnostics/live`) before the graded summary is re-read (`/api/status`), or the second
    // request could race the first and read back a stale observation.
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      const liveIndex = urls.indexOf("/api/diagnostics/live");
      const statusIndex = urls.indexOf("/api/status");
      expect(liveIndex).toBeGreaterThanOrEqual(0);
      expect(statusIndex).toBeGreaterThan(liveIndex);
    });
  });

  /**
   * Task 4's own pinned state: a database that has never been probed reports no `liveness` at all —
   * not a contrived fixture, the ordinary state of a fresh deployment. The very first [지금 확인]
   * can fail (server error, or a session that lapsed mid-click), and `checkError`'s only render path
   * used to sit inside `{status.liveness && (...)}` — which never runs when `status.liveness` is
   * undefined, so the operator this button exists to help most (nothing has ever looked) saw the
   * button quietly return to its resting label with nothing on screen saying anything went wrong.
   */
  it("shows the failure inline when the very first check fails, with nothing ever observed yet", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/translations")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/api/publish/state")) return new Response(JSON.stringify([]), { status: 200 });
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
            // `liveness` genuinely absent — JSON has no way to send `undefined`, so an omitted key is
            // what "never probed" actually looks like on the wire (matches Task 4's fixture for this
            // exact state).
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/diagnostics/live")) {
        return new Response(JSON.stringify({ error: "credential probe timed out" }), { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App onSignOut={() => {}} authEpoch={0} />);
    fireEvent.click(await screen.findByText("local"));
    await screen.findByRole("button", { name: "지금 확인" });
    fireEvent.click(screen.getByRole("button", { name: "지금 확인" }));
    expect(await screen.findByText("⚠ credential probe timed out")).toBeTruthy();
  });

  /**
   * The other half of the fix above: once an observation exists, a later failed re-check must not
   * blank out what the earlier successful one found — `recheckLiveness` deliberately does not call
   * `setStatus` on failure, so the preserved summary and the new error render side by side.
   */
  it("keeps the last-known summary and adds the failure beside it when a later check fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/translations")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/api/publish/state")) return new Response(JSON.stringify([]), { status: 200 });
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
            liveness: { observedAt: new Date().toISOString(), worst: "ok", dead: [], contacted: 7 },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/diagnostics/live")) {
        return new Response(JSON.stringify({ error: "credential probe timed out" }), { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App onSignOut={() => {}} authEpoch={0} />);
    fireEvent.click(await screen.findByText("local"));
    await screen.findByRole("button", { name: "지금 확인" });
    fireEvent.click(screen.getByRole("button", { name: "지금 확인" }));
    expect(await screen.findByText("⚠ credential probe timed out")).toBeTruthy();
    // "방금 전" (reportAge's under-a-minute wording) — the preserved summary from the fixture above,
    // proof `setStatus` was not called on this failed re-check.
    expect(screen.getByText("7개 모두 응답 · 방금 전 확인")).toBeTruthy();
  });
});

/**
 * Task 3's own seam: the storage-mode panel used to be CSS-only (`hidden group-hover:block`), so
 * `지금 확인` sat in the DOM — just invisible per CSS jsdom never evaluates — from the very first
 * render. Now `InfoPopover` owns `open` as React state, so the panel is genuinely absent until a
 * click (or hover, or Enter) puts it there. Touch has no hover path at all, which is why the pill's
 * only *guaranteed* opener in a test is a click.
 */
describe("헤더의 호버 카드", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("스토리지 모드 패널이 클릭으로 열린다 — 터치에는 호버가 없다", async () => {
    stubFetch();
    render(<App onSignOut={() => {}} authEpoch={0} />);

    // status가 실려야 pill이 그려진다.
    await screen.findByText("local");
    expect(screen.queryByText("지금 확인")).toBeNull();

    fireEvent.click(screen.getByText("local"));
    expect(screen.getByText("지금 확인")).toBeTruthy();
  });
});
