// tests/adapters/web/apiHandlers.test.ts
import { describe, it, expect } from "vitest";
import { handleApi, type ApiDeps } from "../../../src/adapters/web/apiHandlers";
import type { BoardView } from "../../../src/adapters/web/board";
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

/** Records what each board dep was asked to do, so a route test can assert the forwarded input. */
interface BoardSpy {
  overrides: unknown[];
  marks: unknown[];
  sends: unknown[];
  boards: string[];
  prepares: unknown[];
  formats: unknown[];
}

/** Shared by every describe block below that needs a spied board (or §10) route. */
function spied(board: Parameters<typeof makeDeps>[4] = {}) {
  const spy: BoardSpy = { overrides: [], marks: [], sends: [], boards: [], prepares: [], formats: [] };
  return { spy, d: makeDeps([], [], [], spy, board) };
}

function makeDeps(
  list: Translation[],
  renderings: ChannelRendering[] = [],
  variants: ContentVariant[] = [],
  spy: BoardSpy = { overrides: [], marks: [], sends: [], boards: [], prepares: [], formats: [] },
  board: Partial<{ override: () => void; mark: () => void; send: () => { sent: number; failed: number; error?: string } }> = {},
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
  const publishOne = async (_id: string, target: string) => ({ uploaded: 1, updated: 0, failed: 0, failures: [], byDrive: { [target]: 1 } });

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
    publishOne,
    storageMode: "cloud",
    formattingStore,
    conversionStore,
    saveRendering,
    approveRendering,
    loadStatus: async () => ({
      storageMode: "cloud" as const,
      funnel: { collected: 5, translated: 3, converted: 2, rendered: 4, published: 1 },
      sync: { synced: 1, needsRepublish: 2, unpublished: 0 },
      availableTargets: ["local"],
      integrations: [],
      sheetLinks: {},
      dbEnv: "development" as const,
    }),
    loadPublishState: async () => [
      { itemId: "x:1", status: "approved", target: "google", url: "https://drive/x1" },
      { itemId: "x:2", status: "approved", target: "local", remoteId: "approved/2026-x2.md", fileName: "2026-x2.md" },
    ],
    loadTranslations: async () => state.list,
    xMaxWeighted: 280,
    loadBoard: async (itemId: string) => {
      spy.boards.push(itemId);
      return { itemId, groups: [], unconverted: [] };
    },
    saveOutletOverride: {
      run: async (input: unknown) => {
        spy.overrides.push(input);
        board.override?.();
        return undefined;
      },
    } as unknown as ApiDeps["saveOutletOverride"],
    markDelivery: {
      run: async (input: unknown) => {
        spy.marks.push(input);
        board.mark?.();
      },
    } as unknown as ApiDeps["markDelivery"],
    reconcilePublished: async () => ({ reconciled: 0, retired: 0, pending: 0 }),
  sendToOutlet: async (itemId: string, type: string, outletId: string) => {
      spy.sends.push({ itemId, type, outletId });
      return board.send?.() ?? { sent: 1, failed: 0 };
    },
    prepareConversionRun: {
      run: async (input: unknown) => {
        spy.prepares.push(input);
        return { worksheetPath: "/ws/batch-1.md", pending: 1 };
      },
    } as unknown as ApiDeps["prepareConversionRun"],
    formatVariants: {
      run: async (input: unknown) => {
        spy.formats.push(input);
        return { renderings: [], warnings: [] };
      },
    } as unknown as ApiDeps["formatVariants"],
    loadQuota: async () => ({ error: "not configured" }),
  };
}

describe("handleApi", () => {
  it("GET /api/translations returns the list", async () => {
    const d = makeDeps([tr({ itemId: "x:1" }), tr({ itemId: "x:2" })]);
    const res = await handleApi(d, "GET", "/api/translations", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation[]).map((t) => t.itemId)).toEqual(["x:1", "x:2"]);
  });

  it("GET /api/translations returns whatever loadTranslations provides (with kind)", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    d.loadTranslations = async () => [{ ...tr({ itemId: "x:1" }), kind: "article" as const }];
    const res = await handleApi(d, "GET", "/api/translations", undefined);
    expect((res.json as any[])[0].kind).toBe("article");
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

  it("POST /api/translations/:id/publish publishes just that item to the target", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/publish", { target: "local" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ uploaded: 1, updated: 0, failed: 0, failures: [], byDrive: { local: 1 } });
  });

  it("POST /api/translations/:id/publish is 400 without a target", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/publish", {});
    expect(res.status).toBe(400);
  });

  it("POST /api/translations/:id/publish is 404 for an unknown id", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A9/publish", { target: "local" });
    expect(res.status).toBe(404);
  });

  it("POST /api/translations/:id/unapprove reverts approved → translated", async () => {
    const d = makeDeps([tr({ itemId: "x:1", status: "approved", approvedAt: "a" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/unapprove", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation).status).toBe("translated");
  });

  it("GET /api/status includes availableTargets", async () => {
    const res = await handleApi(makeDeps([]), "GET", "/api/status", undefined);
    expect((res.json as { availableTargets: string[] }).availableTargets).toEqual(["local"]);
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
      sync: { synced: 1, needsRepublish: 2, unpublished: 0 },
      availableTargets: ["local"],
      integrations: [],
      sheetLinks: {},
      dbEnv: "development",
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

describe("GET /api/renderings/:id/:type/:channel/emissions", () => {
  it("returns only the destinations of that rendering's channel", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "announcement", text: "**중요**" })]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions", undefined);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json as object)).toEqual(["telegram_paste", "telegram_bot"]);
  });

  it("emits each destination's own spelling", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "announcement", text: "**중요**" })]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions", undefined);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe("중요");
    expect(json.telegram_bot.segments[0].text).toBe("<b>중요</b>");
  });

  it("404s for an unknown rendering", async () => {
    const deps = makeDeps([], []);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A9/x/x/emissions", undefined);
    expect(res.status).toBe(404);
  });

  it("emits the stored text as-is, without canonicalising on read", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "announcement", text: "  **중요**  " })]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions", undefined);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe("  중요  ");
  });
});

describe("GET /api/renderings/:id/:type/:channel/emissions/:outletId", () => {
  /** A board whose forked room carries different copy from the group it hangs under. */
  const boardWithFork = (): BoardView => ({
    itemId: "x:1",
    unconverted: [],
    groups: [
      {
        type: "announcement",
        channel: "telegram",
        text: "**그룹**",
        status: "approved",
        addableOutletIds: [],
        rows: [
          { outletId: "tg-community", label: "커뮤니티", delivery: "auto", forked: false, status: "approved", text: "**그룹**", siblingIndex: 1, siblingCount: 1 },
          { outletId: "tg-kol", label: "KOL방", delivery: "manual", forked: true, status: "approved", text: "**KOL방 전용**", siblingIndex: 1, siblingCount: 1 },
        ],
      },
    ],
  });

  /**
   * The whole point of the route: without it the dashboard's [복사] on a forked row can only offer
   * the group's spelling, so a human pastes the wrong copy into a live room.
   */
  it("emits the forked room's own text, not the group's", async () => {
    const deps = makeDeps([]);
    deps.loadBoard = async () => boardWithFork();
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions/tg-kol", undefined);
    expect(res.status).toBe(200);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe("KOL방 전용");
    expect(json.telegram_bot.segments[0].text).toBe("<b>KOL방 전용</b>");
  });

  it("emits the group text for an unforked room", async () => {
    const deps = makeDeps([]);
    deps.loadBoard = async () => boardWithFork();
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions/tg-community", undefined);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe("그룹");
  });

  it("404s for a room the board does not row, and for an unknown group", async () => {
    const deps = makeDeps([]);
    deps.loadBoard = async () => boardWithFork();
    expect((await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions/tg-dev", undefined)).status).toBe(404);
    expect((await handleApi(deps, "GET", "/api/renderings/x%3A1/casual/telegram/emissions/tg-kol", undefined)).status).toBe(404);
  });

  it("decodes the itemId the same way every other route does", async () => {
    const seen: string[] = [];
    const deps = makeDeps([]);
    deps.loadBoard = async (id: string) => {
      seen.push(id);
      return boardWithFork();
    };
    await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions/tg-kol", undefined);
    expect(seen).toEqual(["x:1"]);
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

describe("board routes", () => {
  it("GET /api/items/:id/board decodes the colon in the item id", async () => {
    const { spy, d } = spied();
    const res = await handleApi(d, "GET", "/api/items/x%3A1/board", undefined);
    expect(res.status).toBe(200);
    expect(spy.boards).toEqual(["x:1"]);
    expect(res.json).toEqual({ itemId: "x:1", groups: [], unconverted: [] });
  });

  it("PUT /api/outlets/:itemId/:type/:outletId forks a room with the posted text", async () => {
    const { spy, d } = spied();
    const res = await handleApi(d, "PUT", "/api/outlets/x%3A1/announcement/tg-dev", { text: "데브방용" });
    expect(res.status).toBe(200);
    expect(spy.overrides[0]).toEqual({ itemId: "x:1", type: "announcement", outletId: "tg-dev", text: "데브방용" });
    // The rebuilt board comes back with the mutation, so the card never shows a stale row.
    expect((res.json as { board: { itemId: string } }).board.itemId).toBe("x:1");
  });

  it("PUT forwards approve and revert as their own intents", async () => {
    const { spy, d } = spied();
    await handleApi(d, "PUT", "/api/outlets/x%3A1/announcement/tg-dev", { approve: true });
    await handleApi(d, "PUT", "/api/outlets/x%3A1/announcement/tg-dev", { revert: true });
    expect(spy.overrides).toEqual([
      { itemId: "x:1", type: "announcement", outletId: "tg-dev", approve: true },
      { itemId: "x:1", type: "announcement", outletId: "tg-dev", revert: true },
    ]);
  });

  it("PUT with an empty body is 400 and saves nothing", async () => {
    const { spy, d } = spied();
    const res = await handleApi(d, "PUT", "/api/outlets/x%3A1/announcement/tg-dev", {});
    expect(res.status).toBe(400);
    expect(spy.overrides).toEqual([]);
  });

  it("PUT reports a refused override as 400 with its reason, not a 500", async () => {
    const { d } = spied({ override: () => { throw new Error("unknown outlet: nope"); } });
    const res = await handleApi(d, "PUT", "/api/outlets/x%3A1/announcement/nope", { text: "t" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "unknown outlet: nope" });
  });

  it("POST /api/outlets/:itemId/:type/:outletId/mark ticks and unticks 전달함", async () => {
    const { spy, d } = spied();
    expect((await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-kol/mark", { delivered: true })).status).toBe(200);
    await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-kol/mark", { delivered: false });
    expect(spy.marks).toEqual([
      { itemId: "x:1", type: "announcement", outletId: "tg-kol", delivered: true },
      { itemId: "x:1", type: "announcement", outletId: "tg-kol", delivered: false },
    ]);
  });

  it("POST mark without a boolean is 400", async () => {
    const { spy, d } = spied();
    expect((await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-kol/mark", {})).status).toBe(400);
    expect(spy.marks).toEqual([]);
  });

  it("POST mark reports a refusal (auto room, sent row) as 400 with its reason", async () => {
    const { d } = spied({ mark: () => { throw new Error("tg-dev is an auto room"); } });
    const res = await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/mark", { delivered: true });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "tg-dev is an auto room" });
  });

  it("POST /api/outlets/:itemId/:type/:outletId/send sends exactly that one room's copy", async () => {
    const { spy, d } = spied();
    const res = await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", undefined);
    expect(res.status).toBe(200);
    expect(spy.sends).toEqual([{ itemId: "x:1", type: "announcement", outletId: "tg-dev" }]);
    expect(res.json).toMatchObject({ sent: 1, failed: 0 });
  });

  it("POST send that delivered nothing answers 400 with the reason", async () => {
    const { d } = spied({ send: () => ({ sent: 0, failed: 0, error: "TELEGRAM_CHAT_ID_DEV is not set" }) });
    const res = await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", undefined);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "TELEGRAM_CHAT_ID_DEV is not set" });
  });

  /**
   * The commonest refusal is "already delivered to this room" — the operator ran
   * `pnpm send:channels` in a terminal while the board was open. An error with no board leaves the
   * row still offering [발송] for a room that has already received it, so the screen never
   * self-corrects and the operator's next move is to click it again.
   */
  it("POST send that was refused still answers with the rebuilt board", async () => {
    const { spy, d } = spied({ send: () => ({ sent: 0, failed: 0, error: "already delivered to this room" }) });
    const res = await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", undefined);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "already delivered to this room", board: { itemId: "x:1", groups: [], unconverted: [] } });
    expect(spy.boards).toContain("x:1");
  });

  it("POST send that partly succeeded still answers 200 with the board", async () => {
    const { d } = spied({ send: () => ({ sent: 1, failed: 1, error: "one room failed" }) });
    const res = await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ sent: 1, failed: 1, error: "one room failed" });
  });
});

describe("dashboard save preserves review annotations (isReply/refUrl)", () => {
  function recordingDeps(over: Partial<Translation> = {}) {
    const calls: any[] = [];
    const d = makeDeps([tr({ itemId: "x:1", isReply: true, refUrl: "https://x.com/i/status/1", ...over })]);
    d.saveTranslation = {
      run: async (input: any) => { calls.push(input); return { itemId: input.itemId, promoted: false }; },
    } as unknown as ApiDeps["saveTranslation"];
    return { d, calls };
  }

  it("PUT edit forwards isReply/refUrl from the existing translation", async () => {
    const { d, calls } = recordingDeps();
    await handleApi(d, "PUT", "/api/translations/x%3A1", { koreanText: "새 번역" });
    expect(calls[0]).toMatchObject({ koreanText: "새 번역", approve: false, isReply: true, refUrl: "https://x.com/i/status/1" });
  });

  it("POST approve forwards isReply/refUrl from the existing translation", async () => {
    const { d, calls } = recordingDeps();
    await handleApi(d, "POST", "/api/translations/x%3A1/approve", undefined);
    expect(calls[0]).toMatchObject({ approve: true, isReply: true, refUrl: "https://x.com/i/status/1" });
  });

  it("POST unapprove forwards isReply/refUrl from the existing translation", async () => {
    const { d, calls } = recordingDeps({ status: "approved", approvedAt: "a" });
    await handleApi(d, "POST", "/api/translations/x%3A1/unapprove", undefined);
    expect(calls[0]).toMatchObject({ approve: false, isReply: true, refUrl: "https://x.com/i/status/1" });
  });
});

describe("POST /api/items/:id/convert-prepare", () => {
  it("runs PrepareConversionRun with the decoded item id and the requested types, and returns its result as-is", async () => {
    const { spy, d } = spied();
    d.prepareConversionRun = {
      run: async (input: unknown) => {
        spy.prepares.push(input);
        return { worksheetPath: "/ws/batch-1.md", pending: 2 };
      },
    } as unknown as ApiDeps["prepareConversionRun"];

    const res = await handleApi(d, "POST", "/api/items/x%3A1/convert-prepare", { types: ["announcement", "casual"] });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ worksheetPath: "/ws/batch-1.md", pending: 2 });
    expect(spy.prepares).toEqual([{ itemId: "x:1", types: ["announcement", "casual"] }]);
  });

  it("400s without a non-empty types array", async () => {
    const { spy, d } = spied();
    expect((await handleApi(d, "POST", "/api/items/x%3A1/convert-prepare", {})).status).toBe(400);
    expect((await handleApi(d, "POST", "/api/items/x%3A1/convert-prepare", { types: [] })).status).toBe(400);
    expect((await handleApi(d, "POST", "/api/items/x%3A1/convert-prepare", { types: "announcement" })).status).toBe(400);
    // None of the malformed requests above should have reached the use-case.
    expect(spy.prepares).toEqual([]);
  });

  it("400s on an unknown type, without running the use-case", async () => {
    const { spy, d } = spied();
    const res = await handleApi(d, "POST", "/api/items/x%3A1/convert-prepare", { types: ["announcement", "nope"] });
    expect(res.status).toBe(400);
    expect(spy.prepares).toEqual([]);
  });

  /**
   * `archived` is the operator's only warning that a previous unsaved batch was just moved out from
   * under the agent filling it (`output/variants/pending.json` holds one batch at a time). The route
   * must not drop it just because it is optional.
   */
  it("passes archived through when PrepareConversionRun reports a previous batch was moved", async () => {
    const { d } = spied();
    d.prepareConversionRun = {
      run: async () => ({ worksheetPath: "/ws/batch-2.md", pending: 1, archived: "/archive/2026-07-29/pending-variants-x.json" }),
    } as unknown as ApiDeps["prepareConversionRun"];

    const res = await handleApi(d, "POST", "/api/items/x%3A1/convert-prepare", { types: ["announcement"] });

    expect(res.json).toEqual({ worksheetPath: "/ws/batch-2.md", pending: 1, archived: "/archive/2026-07-29/pending-variants-x.json" });
  });
});

describe("POST /api/items/:id/format", () => {
  it("runs FormatVariants scoped to the item, the requested types and channels", async () => {
    const { spy, d } = spied();
    d.formatVariants = {
      run: async (input: unknown) => {
        spy.formats.push(input);
        return { renderings: [rnd(), rnd()], warnings: [] };
      },
    } as unknown as ApiDeps["formatVariants"];

    const res = await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"], channels: ["telegram"] });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ rendered: 2, warnings: [] });
    expect(spy.formats).toEqual([{ ids: ["x:1"], types: ["announcement"], channels: ["telegram"] }]);
  });

  it("omits channels from the selector when the request does not name any (FormatVariants applies its own defaults)", async () => {
    const { spy, d } = spied();
    d.formatVariants = {
      run: async (input: unknown) => {
        spy.formats.push(input);
        return { renderings: [], warnings: [] };
      },
    } as unknown as ApiDeps["formatVariants"];

    await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"] });

    expect(spy.formats).toEqual([{ ids: ["x:1"], types: ["announcement"], channels: undefined }]);
  });

  it("surfaces FormatVariants' warnings in the response, alongside the rendered count", async () => {
    const { d } = spied();
    const warning = { itemId: "x:1", type: "announcement" as const, channel: "telegram" as const, messages: ["over the X limit"] };
    d.formatVariants = { run: async () => ({ renderings: [rnd()], warnings: [warning] }) } as unknown as ApiDeps["formatVariants"];

    const res = await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"] });

    expect(res.json).toEqual({ rendered: 1, warnings: [warning] });
  });

  it("400s without a non-empty types array, and does not run the use-case", async () => {
    const { spy, d } = spied();
    expect((await handleApi(d, "POST", "/api/items/x%3A1/format", {})).status).toBe(400);
    expect((await handleApi(d, "POST", "/api/items/x%3A1/format", { types: [] })).status).toBe(400);
    expect(spy.formats).toEqual([]);
  });

  it("400s on an unknown type or an unknown channel", async () => {
    const { spy, d } = spied();
    expect((await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["nope"] })).status).toBe(400);
    expect((await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"], channels: ["nope"] })).status).toBe(400);
    expect((await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"], channels: "telegram" })).status).toBe(400);
    expect(spy.formats).toEqual([]);
  });

  /**
   * `FormatVariants.run` reads `selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[...]` — an empty array
   * is not `undefined`, so it would survive that `??` and the use-case would run with zero channels,
   * 200 with `{rendered: 0, warnings: []}`, and silently format nothing. `types: []` is already
   * rejected two lines above this in the handler; `channels: []` must be rejected the same way.
   */
  it("400s on an empty channels array, without running the use-case", async () => {
    const { spy, d } = spied();
    const res = await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"], channels: [] });
    expect(res.status).toBe(400);
    expect(spy.formats).toEqual([]);
  });
});

describe("GET /api/typefully/quota", () => {
  const HEADROOM = { used: 9, remaining: 6, inFlight: 1, available: 5, resetsAt: "2026-08-01T00:00:00+09:00" };

  it("returns the headroom", async () => {
    const d = makeDeps([]);
    d.loadQuota = async () => ({ headroom: HEADROOM });
    const res = await handleApi(d, "GET", "/api/typefully/quota", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ headroom: HEADROOM });
  });

  // The banner must be able to tell "unknown" from "exhausted" — rendering an error as 0 would
  // paint a healthy account as blocked.
  it("returns the error rather than a zero headroom", async () => {
    const d = makeDeps([]);
    d.loadQuota = async () => ({ error: "HTTP 401" });
    const res = await handleApi(d, "GET", "/api/typefully/quota", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ error: "HTTP 401" });
  });

  // Every sibling route in this file bounds its segment length; this one didn't, and matched
  // anything under /api/typefully/quota/... too.
  it("404s on an extra path segment", async () => {
    const d = makeDeps([]);
    const res = await handleApi(d, "GET", "/api/typefully/quota/nope", undefined);
    expect(res.status).toBe(404);
  });
});
