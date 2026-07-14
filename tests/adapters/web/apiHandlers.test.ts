// tests/adapters/web/apiHandlers.test.ts
import { describe, it, expect } from "vitest";
import { handleApi, type ApiDeps } from "../../../src/adapters/web/apiHandlers";
import type { Translation } from "../../../src/domain/translation/models";

function tr(over: Partial<Translation> = {}): Translation {
  return { itemId: "x:1", source: "x", sourceText: "src", koreanText: "ko", status: "translated", translatedAt: "t", ...over };
}

function makeDeps(list: Translation[]): ApiDeps {
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
  const buildPublisher = async () =>
    ({ run: async () => ({ uploaded: 2, failed: 0, byDrive: { google: 2 } }) }) as unknown as Awaited<ReturnType<ApiDeps["buildPublisher"]>>;
  return { translationStore, saveTranslation, buildPublisher };
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

  it("unknown route is 404", async () => {
    const d = makeDeps([]);
    expect((await handleApi(d, "GET", "/api/nope", undefined)).status).toBe(404);
  });
});
