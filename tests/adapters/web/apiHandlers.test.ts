// tests/adapters/web/apiHandlers.test.ts
import { describe, it, expect } from "vitest";
import { handleApi, type ApiDeps } from "../../../src/adapters/web/apiHandlers";
import type { Translation } from "../../../src/domain/translation/models";
import type { ChannelRendering } from "../../../src/domain/formatting/models";
import type { ContentVariant } from "../../../src/domain/conversion/models";

function tr(over: Partial<Translation> = {}): Translation {
  return { itemId: "x:1", source: "x", sourceText: "src", koreanText: "ko", status: "translated", translatedAt: "t", ...over };
}

function rnd(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "x", text: "t", refined: false, createdAt: "c", status: "rendered", ...over };
}
function cv(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "s", convertedText: "변환본", status: "approved", createdAt: "c", ...over };
}

function makeDeps(
  list: Translation[],
  renderings: ChannelRendering[] = [],
  variants: ContentVariant[] = [],
  onBuildPublisher?: (target: string | undefined) => void,
): ApiDeps {
  const state = { list: [...list] };
  const translationStore = {
    loadAll: async () => state.list,
    upsert: async (t: Translation) => {
      state.list = [...state.list.filter((x) => x.itemId !== t.itemId), t];
    },
    listTranslatedIds: async () => new Set(state.list.map((x) => x.itemId)),
  };
  const saveTranslation = {
    run: async (input: { itemId: string; source: "x" | "lark"; sourceText: string; koreanText: string; approve: boolean }) => {
      await translationStore.upsert(tr({ itemId: input.itemId, source: input.source, sourceText: input.sourceText, koreanText: input.koreanText, status: input.approve ? "approved" : "translated", approvedAt: input.approve ? "a" : undefined }));
      return { itemId: input.itemId, promoted: input.approve };
    },
  } as unknown as ApiDeps["saveTranslation"];
  const buildPublisher = async (target: string | undefined) => {
    onBuildPublisher?.(target);
    return { run: async () => ({ uploaded: 2, failed: 0, byDrive: { google: 2 } }) } as unknown as Awaited<
      ReturnType<ApiDeps["buildPublisher"]>
    >;
  };

  const rstate = { list: renderings.map((r) => ({ ...r })) };
  const formattingStore = {
    loadAll: async () => rstate.list,
    listRenderedKeys: async () => new Set(rstate.list.map((r) => `${r.itemId}:${r.type}:${r.channel}`)),
    upsert: async (r: ChannelRendering) => {
      rstate.list = [...rstate.list.filter((x) => !(x.itemId === r.itemId && x.type === r.type && x.channel === r.channel)), r];
    },
  };
  const conversionStore = {
    loadAll: async () => variants,
    upsert: async () => {},
    listConvertedKeys: async () => new Set<string>(),
  };
  const saveRendering = {
    run: async (input: { itemId: string; type: ChannelRendering["type"]; channel: ChannelRendering["channel"]; text: string }) => {
      await formattingStore.upsert(rnd({ itemId: input.itemId, type: input.type, channel: input.channel, text: input.text, refined: true, status: "rendered" }));
      return { itemId: input.itemId, type: input.type, channel: input.channel };
    },
  } as unknown as ApiDeps["saveRendering"];
  const approveRendering = {
    run: async (input: { itemId: string; type: ChannelRendering["type"]; channel: ChannelRendering["channel"] }) => {
      const ex = rstate.list.find((r) => r.itemId === input.itemId && r.type === input.type && r.channel === input.channel);
      if (!ex) return undefined;
      const up: ChannelRendering = { ...ex, status: "approved", approvedAt: "a" };
      await formattingStore.upsert(up);
      return up;
    },
  } as unknown as ApiDeps["approveRendering"];

  return {
    translationStore,
    saveTranslation,
    buildPublisher,
    storageMode: "cloud",
    formattingStore,
    conversionStore,
    saveRendering,
    approveRendering,
    loadStatus: async () => ({
      storageMode: "cloud" as const,
      funnel: { collected: 5, translated: 3, converted: 2, rendered: 4, published: 1 },
      sync: { published: 1, unsynced: 2, stale: 0 },
    }),
    loadPublishState: async () => [
      { itemId: "x:1", status: "approved", target: "google", url: "https://drive/x1" },
      { itemId: "x:2", status: "approved", target: "local", remoteId: "approved/2026-x2.md", fileName: "2026-x2.md" },
    ],
  };
}

describe("handleApi", () => {
  it("GET /api/translations returns the list", async () => {
    const d = makeDeps([tr({ itemId: "x:1" }), tr({ itemId: "x:2" })]);
    const res = await handleApi(d, "GET", "/api/translations", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation[]).map((t) => t.itemId)).toEqual(["x:1", "x:2"]);
  });

  it("PUT edits koreanText and returns the updated (still translated) item", async () => {
    const d = makeDeps([tr({ itemId: "x:1", koreanText: "old" })]);
    const res = await handleApi(d, "PUT", "/api/translations/x%3A1", { koreanText: "새 번역" });
    expect(res.status).toBe(200);
    expect((res.json as Translation).koreanText).toBe("새 번역");
    expect((res.json as Translation).status).toBe("translated");
  });

  it("PUT with empty koreanText is 400", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    expect((await handleApi(d, "PUT", "/api/translations/x%3A1", { koreanText: "" })).status).toBe(400);
  });

  it("PUT unknown id is 404", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    expect((await handleApi(d, "PUT", "/api/translations/x%3A9", { koreanText: "x" })).status).toBe(404);
  });

  it("POST approve promotes to approved", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/approve", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation).status).toBe("approved");
  });

  it("POST /api/publish runs the publisher for the target", async () => {
    const d = makeDeps([tr()]);
    const res = await handleApi(d, "POST", "/api/publish", { target: "google" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ uploaded: 2, failed: 0, byDrive: { google: 2 } });
  });

  it("POST /api/publish with no target still calls buildPublisher with undefined and returns its result", async () => {
    const seen: (string | undefined)[] = [];
    const d = makeDeps([tr()], [], [], (target) => seen.push(target));
    const res = await handleApi(d, "POST", "/api/publish", {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ uploaded: 2, failed: 0, byDrive: { google: 2 } });
    expect(seen).toEqual([undefined]);
  });

  it("unknown route is 404", async () => {
    const d = makeDeps([]);
    expect((await handleApi(d, "GET", "/api/nope", undefined)).status).toBe(404);
  });

  it("GET /api/renderings enriches each rendering with the variant convertedText", async () => {
    const d = makeDeps([], [rnd({ itemId: "x:1", type: "x", channel: "x" })], [cv({ itemId: "x:1", type: "x", convertedText: "변환본" })]);
    const res = await handleApi(d, "GET", "/api/renderings", undefined);
    expect(res.status).toBe(200);
    const list = res.json as (ChannelRendering & { convertedText: string })[];
    expect(list[0].convertedText).toBe("변환본");
  });

  it("PUT edits a rendering's text and reverts it to rendered", async () => {
    const d = makeDeps([], [rnd({ itemId: "x:1", type: "x", channel: "telegram", status: "approved" })]);
    const res = await handleApi(d, "PUT", "/api/renderings/x%3A1/x/telegram", { text: "수정된 텍스트" });
    expect(res.status).toBe(200);
    expect((res.json as ChannelRendering).text).toBe("수정된 텍스트");
    expect((res.json as ChannelRendering).status).toBe("rendered");
  });

  it("PUT empty text is 400; unknown rendering is 404", async () => {
    const d = makeDeps([], [rnd({ itemId: "x:1", type: "x", channel: "x" })]);
    expect((await handleApi(d, "PUT", "/api/renderings/x%3A1/x/x", { text: "" })).status).toBe(400);
    expect((await handleApi(d, "PUT", "/api/renderings/x%3A9/x/x", { text: "y" })).status).toBe(404);
  });

  it("POST approve sets status approved; unknown is 404", async () => {
    const d = makeDeps([], [rnd({ itemId: "x:1", type: "x", channel: "x" })]);
    const res = await handleApi(d, "POST", "/api/renderings/x%3A1/x/x/approve", undefined);
    expect(res.status).toBe(200);
    expect((res.json as ChannelRendering).status).toBe("approved");
    expect((await handleApi(d, "POST", "/api/renderings/x%3A9/x/x/approve", undefined)).status).toBe(404);
  });

  it("GET /api/status returns the storage mode, funnel and sync counts", async () => {
    const res = await handleApi(makeDeps([]), "GET", "/api/status", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      storageMode: "cloud",
      funnel: { collected: 5, translated: 3, converted: 2, rendered: 4, published: 1 },
      sync: { published: 1, unsynced: 2, stale: 0 },
    });
  });

  it("GET /api/publish/state returns the trimmed ledger rows", async () => {
    const res = await handleApi(makeDeps([]), "GET", "/api/publish/state", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual([
      { itemId: "x:1", status: "approved", target: "google", url: "https://drive/x1" },
      { itemId: "x:2", status: "approved", target: "local", remoteId: "approved/2026-x2.md", fileName: "2026-x2.md" },
    ]);
  });
});

describe("GET /api/config", () => {
  it("reports the server's storage mode so the dashboard can pick a publish target", async () => {
    const res = await handleApi(makeDeps([]), "GET", "/api/config", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ storageMode: "cloud" });
  });

  it("reports local mode when the server is in local mode", async () => {
    const deps = { ...makeDeps([]), storageMode: "local" as const };
    const res = await handleApi(deps, "GET", "/api/config", undefined);
    expect(res.json).toEqual({ storageMode: "local" });
  });
});
