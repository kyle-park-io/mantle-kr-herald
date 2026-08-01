// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * A stand-in for `<App>` that carries its own uncontrolled input — standing for the real
 * `TranslationDetail`/`OutletCard` textareas, which live several components below `<App>`. If
 * `Root.tsx` ever went back to swapping `<App>` out for `<LoginPage>` (an unmount) rather than
 * merely hiding it, this input's value would be gone on the next render — exactly what a reviewer's
 * unsaved edit would lose. The mount counter (an empty-deps `useEffect`) catches the same defect a
 * different way: it only advances on a fresh mount, never a re-render or a visibility change.
 */
const { mountCounter } = vi.hoisted(() => ({ mountCounter: { current: 0 } }));

vi.mock("../src/App", async () => {
  const { useEffect, useState } = await import("react");
  return {
    App: () => {
      useEffect(() => {
        mountCounter.current += 1;
      }, []);
      const [draft, setDraft] = useState("");
      return (
        <div data-testid="app-fake">
          <input aria-label="unsaved draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </div>
      );
    },
  };
});

import { Root } from "../src/Root";

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/login")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The concrete defect this closes: at `SESSION_TTL_MS`'s old 12h lifetime, a session lapsing
 * mid-edit was a theoretical concern. At the 2h it is now (see that constant's own comment), a
 * reviewer editing for a while is a realistic way to hit it, and the old behaviour — `main.tsx`
 * swapping `<App>` out for `<LoginPage>` on any 401, `json()`'s `notifyUnauthenticated` included —
 * destroyed every bit of component state under `<App>`, unsaved text included. `Root.tsx` now hides
 * `<App>` instead of unmounting it.
 */
describe("Root", () => {
  beforeEach(() => {
    mountCounter.current = 0;
    window.location.hash = "";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("keeps <App> mounted — and its unsaved text intact — across a session-loss bounce to #login and back", async () => {
    stubFetch();
    render(<Root />);

    expect(mountCounter.current).toBe(1);
    const draftInput = screen.getByLabelText("unsaved draft") as HTMLInputElement;
    fireEvent.change(draftInput, { target: { value: "저장하지 않은 편집" } });
    expect(draftInput.value).toBe("저장하지 않은 편집");

    // The session-loss bounce: `json()` (`api.ts`) calls this on any 401, including one from a save
    // the reviewer just triggered mid-edit — `goToLogin()` in this file sets the hash the same way.
    act(() => {
      window.location.hash = "#login";
      window.dispatchEvent(new Event("hashchange"));
    });

    // <App> (and the draft inside it) is still in the DOM — merely hidden — not unmounted.
    expect(mountCounter.current).toBe(1);
    const stillThere = screen.getByLabelText("unsaved draft") as HTMLInputElement;
    expect(stillThere.value).toBe("저장하지 않은 편집");
    expect(screen.getByTestId("app-fake").closest("[class~='hidden']")).toBeTruthy();

    // The login overlay is now showing on top of it.
    expect(screen.getByRole("button", { name: "로그인" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("아이디"), { target: { value: "herald" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    // Login resolves, the hash returns to where the reviewer actually was ("" — no #login), and the
    // overlay goes away — revealing the same <App> instance, draft intact.
    await waitFor(() => expect(screen.queryByRole("button", { name: "로그인" })).toBeNull());
    expect(mountCounter.current).toBe(1);
    const afterLogin = screen.getByLabelText("unsaved draft") as HTMLInputElement;
    expect(afterLogin.value).toBe("저장하지 않은 편집");
    expect(afterLogin).toBe(draftInput); // the exact same DOM node — never recreated
  });
});
