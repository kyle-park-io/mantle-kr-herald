import { describe, it, expect } from "vitest";
import { TypefullyMedia } from "../../../src/adapters/send/TypefullyMedia";

function routingFetch(overrides: Record<string, () => Response> = {}) {
  const calls: { url: string; method: string; isBinary?: boolean; headers?: any }[] = [];
  const fn = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const isBinary = init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body);
    calls.push({ url: u, method, isBinary, headers: init?.headers });
    for (const key in overrides) if (u.includes(key)) return overrides[key]();
    const reply = (body: unknown, ct = "application/json") =>
      ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(4), headers: { get: () => ct } }) as unknown as Response;
    if (u.includes("pbs.twimg.com")) return reply({}, "image/png");
    if (u.endsWith("/media/upload")) return reply({ media_id: "M1", upload_url: "https://s3.example/put" });
    if (u === "https://s3.example/put") return reply({});
    if (u.includes("/media/M1")) return reply({ status: "ready" });
    return reply({});
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe("TypefullyMedia", () => {
  it("downloads, uploads to presigned S3, polls ready, and returns the media_id", async () => {
    const { fn, calls } = routingFetch();
    const id = await new TypefullyMedia("KEY", "42", fn, noSleep).upload("https://pbs.twimg.com/media/a.png");
    expect(id).toBe("M1");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "PUT", "GET"]); // download, upload, s3 put, poll
    expect(calls.find((c) => c.url === "https://s3.example/put")!.isBinary).toBe(true);
    expect(calls[1].url).toContain("/social-sets/42/media/upload");
    const put = calls.find((c) => c.url === "https://s3.example/put")!;
    expect((put as any).headers?.["Content-Type"]).toBeUndefined();
  });

  it("throws when a media step fails", async () => {
    const { fn } = routingFetch({ "/media/upload": () => ({ ok: false, status: 500, text: async () => "boom" } as Response) });
    await expect(new TypefullyMedia("KEY", "42", fn, noSleep).upload("https://pbs.twimg.com/media/a.png")).rejects.toThrow(/media/i);
  });

  it("throws when processing never becomes ready", async () => {
    const { fn } = routingFetch({ "/media/M1": () => ({ ok: true, status: 200, json: async () => ({ status: "processing" }) } as unknown as Response) });
    await expect(new TypefullyMedia("KEY", "42", fn, noSleep).upload("https://pbs.twimg.com/media/a.png")).rejects.toThrow(/not ready/i);
  });
});
