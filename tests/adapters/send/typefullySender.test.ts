import { describe, it, expect } from "vitest";
import { TypefullySender } from "../../../src/adapters/send/TypefullySender";
import { scheduledPublishAt } from "../../../src/adapters/send/typefullyPublish";

function fakeFetch(responses: { ok: boolean; status: number; body: unknown }[]) {
  const calls: { url: string; method?: string; body: unknown; auth?: string }[] = [];
  let i = 0;
  const fn = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.Authorization });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};
const AT = 1_800_000_000_000; // fixed clock
const now = () => AT;

describe("TypefullySender", () => {
  it("creates a scheduled draft and returns the share_url", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 77, share_url: "https://typefully.com/t/abc" } }]);
    const res = await new TypefullySender("KEY", "42", fn, noSleep, now).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a", "b", "c"] });
    expect(calls[0].url).toContain("/v2/social-sets/42/drafts");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].auth).toBe("Bearer KEY");
    expect((calls[0].body as any).platforms.x.posts).toEqual([{ text: "a" }, { text: "b" }, { text: "c" }]);
    expect((calls[0].body as any).publish_at).toBe(scheduledPublishAt(now)); // future ISO, not "now"
    expect((calls[0].body as any).publish_at).not.toBe("now");
    expect(res).toEqual({ postId: "77", url: "https://typefully.com/t/abc" });
    expect(calls).toHaveLength(1); // no published-url poll
  });

  it("throws on a non-ok create", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 401, body: { detail: "bad key" } }]);
    await expect(new TypefullySender("KEY", "42", fn, noSleep, now).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] }))
      .rejects.toThrow(/401/);
  });
});

function routingFetch() {
  const calls: { url: string; method: string; jsonBody?: any; isBinary?: boolean }[] = [];
  const fn = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const isBinary = init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body);
    calls.push({ url: u, method, isBinary, jsonBody: !isBinary && init?.body ? JSON.parse(init.body) : undefined });
    const reply = (body: unknown, ct = "application/json") =>
      ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
         arrayBuffer: async () => new ArrayBuffer(4), headers: { get: () => ct } }) as unknown as Response;
    if (u.includes("pbs.twimg.com")) return reply({}, "image/jpeg");          // photo download
    if (u.endsWith("/media/upload")) return reply({ media_id: "M1", upload_url: "https://s3.example/put" });
    if (u === "https://s3.example/put") return reply({});                     // S3 PUT
    if (u.includes("/media/M1")) return reply({ status: "ready" });           // poll
    return reply({ id: 77, share_url: "https://typefully.com/t/abc" });       // draft
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("TypefullySender media", () => {
  it("uploads each photo and attaches media_ids to the lead post", async () => {
    const { fn, calls } = routingFetch();
    const res = await new TypefullySender("KEY", "42", fn, noSleep, now).send({
      itemId: "x:1", type: "x", channel: "x", segments: ["hello", "second"],
      photos: ["https://pbs.twimg.com/media/a.jpg"],
    });
    // download → upload → PUT(binary) → poll → draft
    expect(calls.map((c) => `${c.method} ${c.url.includes("pbs") ? "download" : c.url.includes("/media/upload") ? "upload" : c.url.includes("s3") ? "put" : c.url.includes("/media/M1") ? "poll" : "draft"}`))
      .toEqual(["GET download", "POST upload", "PUT put", "GET poll", "POST draft"]);
    const draft = calls.find((c) => c.url.includes("/drafts"))!.jsonBody;
    expect(draft.platforms.x.posts[0]).toEqual({ text: "hello", media_ids: ["M1"] });
    expect(draft.platforms.x.posts[1]).toEqual({ text: "second" });
    expect(calls.find((c) => c.url === "https://s3.example/put")!.isBinary).toBe(true);
    expect(res).toEqual({ postId: "77", url: "https://typefully.com/t/abc" });
  });

  it("throws before creating a draft when a media step fails", async () => {
    const fn = (async (url: string, init?: any) => {
      const u = String(url);
      if (u.endsWith("/media/upload")) return { ok: false, status: 500, text: async () => "boom" } as Response;
      if (u.includes("pbs.twimg.com")) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4), headers: { get: () => "image/jpeg" } } as unknown as Response;
      throw new Error(`unexpected call to ${u}`); // a draft POST here fails the test
    }) as unknown as typeof fetch;
    await expect(
      new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"], photos: ["https://pbs.twimg.com/media/a.jpg"] }),
    ).rejects.toThrow(/media/i);
  });

  it("sends no media_ids when there are no photos (payload unchanged)", async () => {
    const { fn, calls } = routingFetch();
    await new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] });
    expect(calls).toHaveLength(1); // only the draft POST
    expect(calls[0].jsonBody.platforms.x.posts).toEqual([{ text: "a" }]);
  });
});
