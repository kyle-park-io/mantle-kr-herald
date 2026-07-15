import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpClient } from "../../src/shared/http/HttpClient";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("HttpClient", () => {
  it("GET returns parsed JSON and sets query params + headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const client = new HttpClient("https://api.example.com", { "x-api-key": "k" });

    const result = await client.get<{ ok: number }>("/path", { a: "1", empty: "" });

    expect(result).toEqual({ ok: 1 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.has("empty")).toBe(false); // empty params dropped
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(429, { detail: "slow down" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 2 }));
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const client = new HttpClient("https://api.example.com");

    const result = await client.get<{ ok: number }>("/x");

    expect(result).toEqual({ ok: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(401, { detail: "bad key" }));
    const client = new HttpClient("https://api.example.com");
    await expect(client.get("/x")).rejects.toThrow(/401|unauthorized/i);
  });

  it("exhausts retries without a final backoff and names the last status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(503, { detail: "down" }));
    const timeoutMock = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const client = new HttpClient("https://api.example.com");

    await expect(client.get("/x")).rejects.toThrow(/3 attempts.*503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(timeoutMock).toHaveBeenCalledTimes(2); // no backoff after the 3rd (final) attempt
  });

  it("retries a network error and wraps it with context on exhaustion", async () => {
    const boom = new Error("ECONNRESET");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(boom);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const client = new HttpClient("https://api.example.com");

    await expect(client.get("/x")).rejects.toThrow(/3 attempts.*network error/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers when a network error is followed by success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 3 }));
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const client = new HttpClient("https://api.example.com");

    expect(await client.get<{ ok: number }>("/x")).toEqual({ ok: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
