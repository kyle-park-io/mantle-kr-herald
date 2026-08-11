// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IntakeView } from "../src/components/IntakeView";

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

  it("submits a link and reports the outcome", async () => {
    stubFetch({
      "POST /api/intake/x": () =>
        new Response(JSON.stringify({ itemId: "x:7", tweets: 2, outcome: "collected", pending: PENDING }), { status: 200 }),
    });
    render(<IntakeView authEpoch={0} intakeEnabled={true} />);
    await screen.findByText("waiting post");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://x.com/someone/status/7" } });
    fireEvent.click(screen.getByRole("button", { name: "넣기" }));

    expect(await screen.findByText("수집됐습니다 — 다음 번역 틱에서 초안이 만들어집니다")).toBeTruthy();
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

  it("disables 넣기 and says why when the deployment has no X credentials", async () => {
    stubFetch();
    render(<IntakeView authEpoch={0} intakeEnabled={false} />);
    await screen.findByText("waiting post");

    const button = screen.getByRole("button", { name: "넣기" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("이 배포에는 TWITTERAPI_IO_KEY가 없어 링크 수집을 할 수 없습니다")).toBeTruthy();
  });

  it("keeps the queue visible when intake is closed", async () => {
    // The list reads the database only — an operator without the key should still see what is queued.
    stubFetch();
    render(<IntakeView authEpoch={0} intakeEnabled={false} />);
    expect(await screen.findByText("waiting post")).toBeTruthy();
  });
});
