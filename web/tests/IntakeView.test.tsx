// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IntakeView } from "../src/components/IntakeView";
import { INTAKE_DISABLED_MESSAGE } from "../src/types";

// `@testing-library/user-event` is not a dependency of this repo (checked `package.json` and
// `node_modules/@testing-library` before writing this), so every interaction below goes through
// `fireEvent` instead of the brief's original `userEvent.type`/`userEvent.click`.

const PENDING = [{ itemId: "x:9", text: "waiting post", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" as const }];

function stubFetch(extra: Record<string, () => Response> = {}) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (extra[key]) return extra[key]();
    if (key === "GET /api/intake/pending") return new Response(JSON.stringify(PENDING), { status: 200 });
    throw new Error(`unexpected fetch: ${key}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IntakeView", () => {
  it("shows what is already waiting", async () => {
    stubFetch();
    render(<IntakeView authEpoch={0} intakeEnabled={true} />);
    expect(await screen.findByText("waiting post")).toBeTruthy();
  });

  /**
   * The concrete cold-start failure `authEpoch`'s own doc comment in `IntakeView.tsx` exists to
   * recover from: `<App>` hides across a `#login` round trip rather than unmounting, so this
   * component's first mount can 401 before the user has logged in. Once they do, `authEpoch` bumps
   * and `refresh()` reruns and succeeds — but if `refresh` only ever *sets* `error` and never clears
   * it, the stale 401 banner from the first failed read sits on screen forever next to a list that is
   * now populated correctly. Pins that `refresh` clears its own prior error, the same way
   * `handleSubmit` already clears one before a new submit attempt.
   */
  it("clears a stale error once a later refresh succeeds", async () => {
    let pendingCalls = 0;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      if (key === "GET /api/intake/pending") {
        pendingCalls += 1;
        // First read (the cold-start mount) 401s; every read after that succeeds.
        return pendingCalls === 1
          ? new Response(JSON.stringify({ error: "로그인이 필요합니다" }), { status: 401 })
          : new Response(JSON.stringify(PENDING), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${key}`);
    });
    vi.stubGlobal("fetch", mock);

    const { rerender } = render(<IntakeView authEpoch={0} intakeEnabled={true} />);
    await screen.findByText("로그인이 필요합니다");

    // The `#login` round trip bumps `authEpoch` without unmounting `<IntakeView>`.
    rerender(<IntakeView authEpoch={1} intakeEnabled={true} />);

    expect(await screen.findByText("waiting post")).toBeTruthy();
    expect(screen.queryByText("로그인이 필요합니다")).toBeNull();
  });

  it("submits a link and reports the outcome", async () => {
    stubFetch({
      "POST /api/intake/x": () =>
        new Response(JSON.stringify({ itemId: "x:7", tweets: 2, outcome: "collected", pending: PENDING }), { status: 200 }),
    });
    render(<IntakeView authEpoch={0} intakeEnabled={true} />);
    await screen.findByText("waiting post");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://x.com/someone/status/7" } });
    fireEvent.click(screen.getByRole("button", { name: "넣기" }));

    expect(await screen.findByText("수집됐습니다 — 번역 틱이 돌면 초안이 만들어집니다")).toBeTruthy();
  });

  it("shows the server's refusal instead of a generic failure", async () => {
    stubFetch({
      "POST /api/intake/x": () =>
        new Response(JSON.stringify({ error: "이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다" }), { status: 400 }),
    });
    render(<IntakeView authEpoch={0} intakeEnabled={true} />);
    await screen.findByText("waiting post");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://x.com/someone/status/7" } });
    fireEvent.click(screen.getByRole("button", { name: "넣기" }));

    expect(
      await screen.findByText("이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다"),
    ).toBeTruthy();
  });

  it("disables 넣기 and says so when intake is closed on this deployment", async () => {
    stubFetch();
    render(<IntakeView authEpoch={0} intakeEnabled={false} />);
    await screen.findByText("waiting post");

    const button = screen.getByRole("button", { name: "넣기" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The constant rather than a second copy of the sentence: `tests/web/typeMirror.test.ts`
    // already pins it byte-identical to the server's, and intake is closed by either the
    // HERALD_INTAKE_ENABLED flag or a missing credential, so this assertion has no business
    // naming one of the two.
    expect(screen.getByText(INTAKE_DISABLED_MESSAGE)).toBeTruthy();
  });

  it("keeps the queue visible when intake is closed", async () => {
    // The list reads the database only — an operator without the key should still see what is queued.
    stubFetch();
    render(<IntakeView authEpoch={0} intakeEnabled={false} />);
    expect(await screen.findByText("waiting post")).toBeTruthy();
  });
});
