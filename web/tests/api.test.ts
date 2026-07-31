import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, api, installUnauthenticatedHandler } from "../src/api";

/**
 * `json()` is the one place every API call in this module passes through — see its own doc comment
 * in `api.ts`. These tests are about that chokepoint itself: whether a 401 fires the redirect hook
 * and a 400 does not, since a board refusal (`이미 발송된 방입니다`) must keep showing its message in
 * place rather than bounce the reviewer to a login screen mid-edit.
 */
describe("json()", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    installUnauthenticatedHandler(() => {});
  });

  it("sends the browser to #login when the API answers 401", async () => {
    const onUnauthenticated = vi.fn();
    installUnauthenticatedHandler(onUnauthenticated);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }));
    await expect(json("/api/translations")).rejects.toThrow();
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it("does not redirect on a 400 — a refused action is not a lost session", async () => {
    const onUnauthenticated = vi.fn();
    installUnauthenticatedHandler(onUnauthenticated);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "이미 발송된 방입니다" }), { status: 400 }));
    await expect(json("/api/outlets/x:1/announcement/tg-community/send")).rejects.toThrow();
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it("does not redirect on success", async () => {
    const onUnauthenticated = vi.fn();
    installUnauthenticatedHandler(onUnauthenticated);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(json("/api/status")).resolves.toEqual({ ok: true });
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it("throws with the server's message on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "아이디 또는 비밀번호가 맞지 않습니다." }), { status: 401 }));
    await expect(json("/api/login")).rejects.toThrow("아이디 또는 비밀번호가 맞지 않습니다.");
  });

  /**
   * `OutletCard` branches on `e instanceof ApiError && e.board` to repaint the board a refused send
   * came back with, rather than leaving the row stuck offering an action the server already refused.
   */
  it("carries a refused action's rebuilt board on the thrown error", async () => {
    const board = { itemId: "x:1", groups: [], unconverted: [] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "이미 발송된 방입니다", board }), { status: 400 }));
    await expect(json("/api/outlets/x:1/announcement/tg-community/send")).rejects.toMatchObject({
      message: "이미 발송된 방입니다",
      board,
    });
  });
});

describe("api.logout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to /api/logout", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.logout();

    expect(fetchMock).toHaveBeenCalledWith("/api/logout", expect.objectContaining({ method: "POST" }));
  });
});

describe("api.typefullyQuota", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The banner's own documented contract: never throws, even when the underlying request fails
   * outright (a 401 included, once `json()` has already fired the redirect hook for it).
   */
  it("never throws, even on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 })));
    await expect(api.typefullyQuota()).resolves.toEqual({});
  });
});
