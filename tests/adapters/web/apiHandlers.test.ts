// tests/adapters/web/apiHandlers.test.ts
import { describe, it, expect } from "vitest";
import { handleApi, INTAKE_DISABLED_MESSAGE, type ApiDeps } from "../../../src/adapters/web/apiHandlers";
import type { BoardView } from "../../../src/adapters/web/board";
import type { Translation } from "../../../src/domain/translation/models";
import type { ChannelRendering } from "../../../src/domain/formatting/models";
import type { ContentVariant } from "../../../src/domain/conversion/models";
import { SESSION_TTL_MS } from "../../../src/domain/auth/session";
import { krLinkNotice } from "../../../src/domain/formatting/krLinks";

/**
 * None of these tests are about the session gate (that is `gate.test.ts`'s job) — they exercise the
 * routes below it, so every `ApiDeps` this file builds carries an already-authenticated session by
 * default, the same way it carries harmless stubs for every other dependency a given test does not
 * care about.
 */
const AUTHENTICATED_SESSION = { issuedAt: new Date().toISOString() };

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
      funnel: {
        // With its breakdown, because the route must forward it: the header's `수집 5` is the number
        // that was misread once already, and the card under it is the only thing on that screen that
        // says where it came from.
        collected: {
          items: 5,
          rows: 5,
          breakdown: {
            intake: [
              { kind: "threads" as const, count: 9 },
              { kind: "replies-dropped" as const, op: "-" as const, count: 5 },
              { kind: "lark" as const, op: "+" as const, count: 1 },
            ],
            total: 5,
            reach: { kind: "measured" as const, inScope: 2, belowFloor: 3, floor: "2026-07-27T14:35:25.000Z" },
          },
        },
        translated: { items: 3, rows: 3 },
        // Distinct items and rows deliberately differ past the branch, so a handler that
        // flattened the tally back to one number would show up here.
        converted: { items: 2, rows: 6 },
        rendered: { items: 2, rows: 4 },
        published: { items: 1, rows: 3 },
      },
      sync: { synced: 1, needsRepublish: 2, unpublished: 0 },
      availableTargets: ["local"],
      integrations: [],
      sheetLinks: {},
      dbEnv: "development" as const,
      sendsEnabled: true,
      conversionEnabled: true,
      intakeEnabled: true,
    }),
    loadPublishState: async () => [
      { itemId: "x:1", status: "approved", target: "google", url: "https://drive/x1" },
      { itemId: "x:2", status: "approved", target: "local", remoteId: "approved/2026-x2.md", fileName: "2026-x2.md" },
    ],
    loadTranslations: async () => state.list,
    // Nothing posted to X — the default a 미리보기 test wants unless it is specifically about the CTA,
    // since that is the state a rendering is in for most of its life (see `xLinkCta.ts`).
    loadXPostUrl: async () => undefined,
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
    // Mirrors what createDeps.ts's real implementation does — status flips to "translated", every
    // other column (postedUrl/postedAt included) is carried through unchanged, exactly the shape
    // SaveTranslation.run's own preservation of postedUrl/postedAt already guarantees in production
    // (see tests/app/saveTranslation.test.ts). Route-level tests below check the wiring, not that
    // guarantee itself.
    unretireTranslation: async (itemId: string) => {
      const ex = state.list.find((t) => t.itemId === itemId);
      if (!ex) return;
      await translationStore.upsert({ ...ex, status: "translated" });
    },
    // Mirrors createDeps.ts's real implementation: status only, every other column carried through,
    // which is what lets an edit made after the dispute survive the restore.
    retireTranslation: async (itemId: string) => {
      const ex = state.list.find((t) => t.itemId === itemId);
      if (!ex) return;
      await translationStore.upsert({ ...ex, status: "posted" });
    },
    sendToOutlet: async (itemId: string, type: string, outletId: string, opts?: { resend?: boolean; pin?: boolean }) => {
      spy.sends.push({ itemId, type, outletId, opts });
      return board.send?.() ?? { sent: 1, failed: 0 };
    },
    prepareConversionRun: {
      run: async (input: unknown) => {
        spy.prepares.push(input);
        return { worksheetPath: "/ws/batch-1.md", pending: 1 };
      },
    } as unknown as ApiDeps["prepareConversionRun"],
    collectLinkedThread: {
      run: async () => ({ itemId: "x:1", tweets: 1, outcome: "collected" as const }),
    } as unknown as ApiDeps["collectLinkedThread"],
    loadIntakePending: async () => [],
    formatVariants: {
      run: async (input: unknown) => {
        spy.formats.push(input);
        return { renderings: [], warnings: [], skippedPosted: [] };
      },
    } as unknown as ApiDeps["formatVariants"],
    loadQuota: async () => ({ error: "not configured" }),
    probeLiveness: async () => [],
    login: async () => ({ ok: false, retryAfterMs: 0 }),
    sessionConfig: { secret: "test-secret-at-least-32-characters-long", ttlMs: SESSION_TTL_MS },
    ipConfig: { trustProxy: false, trustedHopsFromEnd: 1 },
    clientIp: undefined,
    session: AUTHENTICATED_SESSION,
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

  /**
   * 되돌리기: the dashboard's dispute button for a reconcile-retired item (Task 5). `postedUrl`
   * surviving the round trip is not incidental — it is what stops the next `x:reconcile` tick from
   * re-retiring the same item (`RetireTranslation.run` skips whenever `postedUrl` is already set).
   */
  /**
   * The other half of the door. `unretire` disputes a reconcile match; without this route that
   * dispute is irreversible — `postedUrl` survives it precisely so the next unattended tick will
   * not re-retire the item (`ReconcileXPublished`, "never scored — read, not re-matched"), and
   * `RetireTranslation` reports `already-retired` without writing whenever `postedUrl` is set. So
   * nothing in the system could put the item back, and a mis-click was permanent.
   */
  it("POST /api/translations/:id/retire puts a disputed item back on posted", async () => {
    const d = makeDeps([
      tr({ itemId: "x:1", status: "translated", postedUrl: "https://x.com/0xMantleKR/status/1", postedAt: "p" }),
    ]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/retire", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation).status).toBe("posted");
    expect((res.json as Translation).postedUrl).toBe("https://x.com/0xMantleKR/status/1");
  });

  /**
   * The invariant that keeps this route from inventing history: 게시됨 may only be restored on an
   * item that carries the evidence it was posted. Without the guard the route is a way to mark any
   * draft as published — which would then leave 1차 검수, refuse approval, and claim a post that
   * does not exist.
   */
  it("POST /api/translations/:id/retire refuses an item that was never posted", async () => {
    const d = makeDeps([tr({ itemId: "x:1", status: "translated" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/retire", undefined);
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toMatch(/게시/);
  });

  it("POST /api/translations/:id/retire keeps an edit made after the dispute", async () => {
    // Kyle's call: the reviewer may edit after 되돌리기, and restoring 게시됨 keeps that edit rather
    // than refusing. `publishedText` still holds what actually went out, and 1차 검수 diffs the two —
    // so the divergence is shown, not hidden.
    const d = makeDeps([
      tr({
        itemId: "x:1",
        status: "translated",
        koreanText: "고쳐 쓴 초안",
        publishedText: "실제로 나간 글",
        postedUrl: "https://x.com/0xMantleKR/status/1",
      }),
    ]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/retire", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation).koreanText).toBe("고쳐 쓴 초안");
    expect((res.json as Translation).publishedText).toBe("실제로 나간 글");
  });

  it("POST /api/translations/:id/unretire moves it off posted and keeps postedUrl", async () => {
    const d = makeDeps([
      tr({ itemId: "x:1", status: "posted", postedUrl: "https://x.com/0xMantleKR/status/1", postedAt: "p" }),
    ]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/unretire", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation).status).toBe("translated");
    expect((res.json as Translation).postedUrl).toBe("https://x.com/0xMantleKR/status/1");
  });

  /**
   * Final review, Minor 6 + Important 2. The design's stated defence against posting the same copy
   * twice is "a retired item cannot be approved, so it cannot be converted, formatted, or sent."
   * That was enforced only by `TranslationDetail.tsx` disabling the buttons — a stale tab, a double
   * submit landing after a concurrent retire, or a plain `curl` with a valid session cookie all
   * reached the handler and went through. Publishing had a second cost on top: it demoted an already
   * published approved doc to review/ and deleted it.
   *
   * Asserted per route rather than as one loop, because each one has to fail for its own reason and
   * a shared loop would pass if the guard were attached to only the cheapest of them.
   */
  describe("a `posted` item is refused by every mutating route", () => {
    const posted = () => makeDeps([tr({ itemId: "x:1", status: "posted", postedUrl: "https://x.com/0xMantleKR/status/1", postedAt: "p" })]);

    it("POST approve answers 409 and does not promote it", async () => {
      const d = posted();
      const res = await handleApi(d, "POST", "/api/translations/x%3A1/approve", undefined);
      expect(res.status).toBe(409);
      // Not merely a rejected response — the row must be untouched, since `saveTranslation.run` here
      // is the real write path and would have moved it to `approved`.
      expect((await d.translationStore.loadAll())[0].status).toBe("posted");
    });

    it("PUT save answers 409 and does not rewrite the Korean text", async () => {
      const d = posted();
      const res = await handleApi(d, "PUT", "/api/translations/x%3A1", { koreanText: "몰래 고친 번역" });
      expect(res.status).toBe(409);
      const after = (await d.translationStore.loadAll())[0];
      expect(after.status).toBe("posted");
      expect(after.koreanText).not.toBe("몰래 고친 번역");
    });

    it("POST publish answers 409 rather than a silent all-zeros result", async () => {
      // `PublishTranslations` already skips a posted item, so without this gate the route answered
      // 200 with `uploaded: 0` — indistinguishable from a failed upload, and no reason given.
      const called: string[] = [];
      const d = { ...posted(), publishOne: async (id: string) => { called.push(id); return { uploaded: 0, updated: 0, failed: 0, failures: [], byDrive: {} }; } };
      const res = await handleApi(d, "POST", "/api/translations/x%3A1/publish", { target: "local" });
      expect(res.status).toBe(409);
      expect(called).toEqual([]);
    });

    it("but 되돌리기 still works — it is the only way off `posted`", async () => {
      // Gating unretire too would make the state unescapable, which is the one thing worse than the
      // hole this describe block closes.
      const d = posted();
      const res = await handleApi(d, "POST", "/api/translations/x%3A1/unretire", undefined);
      expect(res.status).toBe(200);
    });

    it("and an ordinary translated item is not touched by the gate", async () => {
      const d = makeDeps([tr({ itemId: "x:1", status: "translated" })]);
      expect((await handleApi(d, "POST", "/api/translations/x%3A1/approve", undefined)).status).toBe(200);
    });
  });

  it("POST /api/translations/:id/unretire returns 404 for an unknown id", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A9/unretire", undefined);
    expect(res.status).toBe(404);
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

  it("GET /api/renderings drops the cards of an item whose 1차 is 게시됨", async () => {
    // The ordinary end of an item's life: approved, rendered, sent, then retired to `posted`. Its
    // cards can no longer be sent (`sendBlock`) nor rebuilt (`FormatVariants`), so the 2차 board —
    // which answers "what is left to review" — must not keep listing them.
    const d = makeDeps(
      [tr({ itemId: "x:1", status: "posted" }), tr({ itemId: "x:2", status: "approved" })],
      [rnd({ itemId: "x:1", type: "x", channel: "x" }), rnd({ itemId: "x:2", type: "x", channel: "x" })],
    );
    const res = await handleApi(d, "GET", "/api/renderings", undefined);
    expect((res.json as ChannelRendering[]).map((r) => r.itemId)).toEqual(["x:2"]);
  });

  it("GET /api/renderings keeps a 되돌리기'd item, and one with no 1차 row at all", async () => {
    // Only an explicit `posted` means finished. `translated` is where 되돌리기 lands — the board is
    // where its block gets explained — and a missing translation row is an anomaly, not an ending.
    const d = makeDeps(
      [tr({ itemId: "x:1", status: "translated" })],
      [rnd({ itemId: "x:1", type: "x", channel: "x" }), rnd({ itemId: "x:9", type: "x", channel: "x" })],
    );
    const res = await handleApi(d, "GET", "/api/renderings", undefined);
    expect((res.json as ChannelRendering[]).map((r) => r.itemId)).toEqual(["x:1", "x:9"]);
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
      funnel: {
        // Forwarded whole, breakdown included — a route that dropped it would leave the header with
        // the bare total and nothing to explain it, which is where this started.
        collected: {
          items: 5,
          rows: 5,
          breakdown: {
            intake: [
              { kind: "threads", count: 9 },
              { kind: "replies-dropped", op: "-", count: 5 },
              { kind: "lark", op: "+", count: 1 },
            ],
            total: 5,
            reach: { kind: "measured", inScope: 2, belowFloor: 3, floor: "2026-07-27T14:35:25.000Z" },
          },
        },
        translated: { items: 3, rows: 3 },
        // Distinct items and rows deliberately differ past the branch, so a handler that
        // flattened the tally back to one number would show up here.
        converted: { items: 2, rows: 6 },
        rendered: { items: 2, rows: 4 },
        published: { items: 1, rows: 3 },
      },
      sync: { synced: 1, needsRepublish: 2, unpublished: 0 },
      availableTargets: ["local"],
      integrations: [],
      sheetLinks: {},
      dbEnv: "development",
      sendsEnabled: true,
      conversionEnabled: true,
      intakeEnabled: true,
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

/**
 * `explainer` — neither `announcement` nor `x` — in every fixture below that asserts an exact
 * emitted string. These tests are about destination spelling and about the route NOT touching the
 * stored text, and two of the route's steps now edit that text before it is emitted: a 공지 has the
 * X-link CTA appended (`xLinkCta.ts`), and an `x` rendering has its Mantle Global links rewritten
 * (`krLinks.ts`). Either type would make each assertion here a statement about that step as well.
 * `explainer` takes neither. Do not move them onto either type — both steps have their own describe
 * block further down, which is where a change to them should fail.
 */
describe("GET /api/renderings/:id/:type/:channel/emissions", () => {
  it("returns only the destinations of that rendering's channel", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "explainer", text: "**중요**" })]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/explainer/telegram/emissions", undefined);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json as object)).toEqual(["telegram_paste", "telegram_bot"]);
  });

  it("emits each destination's own spelling", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "explainer", text: "**중요**" })]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/explainer/telegram/emissions", undefined);
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
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "explainer", text: "  **중요**  " })]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/explainer/telegram/emissions", undefined);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe("  중요  ");
  });
});

describe("GET /api/renderings/:id/:type/:channel/emissions/:outletId", () => {
  /**
   * A board whose forked room carries different copy from the group it hangs under.
   *
   * `explainer` for the same reason the block above uses it: every assertion here is an exact
   * emitted string, and a 공지 would carry the X-link CTA into all of them while an `x` rendering
   * would carry the Korean-link rewrite. What this block is about is *which* text a room gets, not
   * what the route then does to it.
   */
  const boardWithFork = (): BoardView => ({
    itemId: "x:1",
    unconverted: [],
    groups: [
      {
        type: "explainer",
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
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/explainer/telegram/emissions/tg-kol", undefined);
    expect(res.status).toBe(200);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe("KOL방 전용");
    expect(json.telegram_bot.segments[0].text).toBe("<b>KOL방 전용</b>");
  });

  it("emits the group text for an unforked room", async () => {
    const deps = makeDeps([]);
    deps.loadBoard = async () => boardWithFork();
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/explainer/telegram/emissions/tg-community", undefined);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe("그룹");
  });

  it("404s for a room the board does not row, and for an unknown group", async () => {
    const deps = makeDeps([]);
    deps.loadBoard = async () => boardWithFork();
    expect((await handleApi(deps, "GET", "/api/renderings/x%3A1/explainer/telegram/emissions/tg-dev", undefined)).status).toBe(404);
    expect((await handleApi(deps, "GET", "/api/renderings/x%3A1/casual/telegram/emissions/tg-kol", undefined)).status).toBe(404);
  });

  it("decodes the itemId the same way every other route does", async () => {
    const seen: string[] = [];
    const deps = makeDeps([]);
    deps.loadBoard = async (id: string) => {
      seen.push(id);
      return boardWithFork();
    };
    await handleApi(deps, "GET", "/api/renderings/x%3A1/explainer/telegram/emissions/tg-kol", undefined);
    expect(seen).toEqual(["x:1"]);
  });
});

/**
 * The [복사] preview is not a convenience for a 공지 — for every KakaoTalk room and two of the
 * Telegram rooms (`delivery: "manual"`, `src/domain/outlet/models.ts`) it IS the send path: a human
 * copies what this returns and pastes it into the live room. A CTA missing here, or spelled
 * differently from `SendChannels`, means the copy a room receives depends on who sent it.
 */
const X_URL = "https://x.com/0xMantleKR/status/2087418810458382585";

describe("공지 X-link CTA in emissions", () => {
  it("uses 👉 for a kakao 공지", async () => {
    // `kakao_notice`, not `announcement`: since the 공지 split the kakao card is its own type, so an
    // `announcement`-typed kakao preview would be testing the icon on a pair nothing produces any
    // more. (`needsXLinkCta` still answers for that pair — it is asked about stored rows, and its
    // own test is what pins that.)
    const deps = makeDeps([], [rnd({ channel: "kakao", type: "kakao_notice", text: "본문" })]);
    deps.loadXPostUrl = async () => X_URL;
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/kakao_notice/kakao/emissions", undefined);
    expect(JSON.stringify(res.json)).toContain(`👉 자세한 내용은 X에서 확인하세요 (${X_URL})`);
  });

  it("uses ➡ for a telegram 공지", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "announcement", text: "본문" })]);
    deps.loadXPostUrl = async () => X_URL;
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions", undefined);
    expect(JSON.stringify(res.json)).toContain(`➡ 자세한 내용은 X에서 확인하세요 (${X_URL})`);
  });

  it("shows a placeholder when the X post is not up yet", async () => {
    const deps = makeDeps([], [rnd({ channel: "kakao", type: "kakao_notice", text: "본문" })]);
    deps.loadXPostUrl = async () => undefined;
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/kakao_notice/kakao/emissions", undefined);
    expect(JSON.stringify(res.json)).toContain("X 게시 후 채워짐");
  });

  it("does not add a CTA to a 해설", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "explainer", text: "본문" })]);
    deps.loadXPostUrl = async () => X_URL;
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/explainer/telegram/emissions", undefined);
    expect(JSON.stringify(res.json)).not.toContain("자세한 내용은 X에서 확인하세요");
  });

  /**
   * Byte-for-byte agreement with `SendChannels`: one blank line between body and CTA, the CTA last,
   * and the body untouched. Asserted on the emitted text rather than by `toContain`, so a stray
   * newline or a CTA landing in front of the body would fail here rather than pass a substring check.
   */
  it("appends the CTA after the body, separated by one blank line", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "announcement", text: "본문" })]);
    deps.loadXPostUrl = async () => X_URL;
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions", undefined);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe(`본문\n\n➡ 자세한 내용은 X에서 확인하세요 (${X_URL})`);
  });

  /**
   * The per-room route carries it too. A forked KOL방 is `delivery: "manual"`, so this is the exact
   * text a human copies — the route the group-level test above does not cover.
   */
  it("carries the CTA onto a forked room's own copy", async () => {
    const deps = makeDeps([]);
    deps.loadXPostUrl = async () => X_URL;
    deps.loadBoard = async () => ({
      itemId: "x:1",
      unconverted: [],
      groups: [
        {
          type: "announcement" as const,
          channel: "telegram" as const,
          text: "그룹",
          status: "approved" as const,
          addableOutletIds: [],
          rows: [
            { outletId: "tg-kol", label: "KOL방", delivery: "manual" as const, forked: true, status: "approved" as const, text: "KOL방 전용", siblingIndex: 1, siblingCount: 1 },
          ],
        },
      ],
    });
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions/tg-kol", undefined);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe(`KOL방 전용\n\n➡ 자세한 내용은 X에서 확인하세요 (${X_URL})`);
  });

  /** The url is looked up for the item under review, not for whatever the last request asked about. */
  it("asks for the X post url of the decoded itemId", async () => {
    const seen: string[] = [];
    const deps = makeDeps([], [rnd({ itemId: "x:7", channel: "kakao", type: "kakao_notice", text: "본문" })]);
    deps.loadXPostUrl = async (id: string) => {
      seen.push(id);
      return X_URL;
    };
    await handleApi(deps, "GET", "/api/renderings/x%3A7/kakao_notice/kakao/emissions", undefined);
    expect(seen).toEqual(["x:7"]);
  });
});

/**
 * A Mantle Global post that links another Mantle Global post, seen from the Korean side: `x` copy is
 * translated near-verbatim, so the source's inline link rides along and — unrewritten — sends a
 * Korean reader back to the English original (`src/domain/formatting/krLinks.ts`).
 *
 * These tests are about the ROUTE: that it resolves each linked post through the deps it already
 * has, hands `emitAll` the substituted text, and surfaces what it could not resolve. The wording of
 * the notice and the rules for which links count are `krLinks.test.ts`'s, which is why the expected
 * notice below is `krLinkNotice(n)` rather than a re-spelled sentence — a copy here would pass while
 * disagreeing with the only place that string is authored.
 */
const GLOBAL_URL = (id: string) => `https://x.com/Mantle_Official/status/${id}`;
const KR_URL_2 = "https://x.com/0xMantleKR/status/2087418810458382599";

/** What `/emissions` answers with, at the depth these tests read it. */
type EmissionsJson = Record<string, { segments: { text: string }[]; warnings: string[] }>;

describe("글로벌 링크 → 한국 링크 in emissions", () => {
  /** An `x` rendering whose copy carries the source tweet's own link. */
  const xRnd = (text: string, itemId = "x:1") => rnd({ itemId, type: "x", channel: "x", text });

  it("shows the linked post's Korean url instead of the global one", async () => {
    const deps = makeDeps([], [xRnd(`본문\n${GLOBAL_URL("111")}`)]);
    deps.loadXPostUrl = async (id) => (id === "x:111" ? X_URL : undefined);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/x/x/emissions", undefined);
    expect(res.status).toBe(200);
    const json = res.json as EmissionsJson;
    expect(json.x_paste.segments[0].text).toBe(`본문\n${X_URL}`);
    // Not a `toContain` on the Korean url: the global one must be gone from every destination, not
    // merely joined by its replacement.
    expect(JSON.stringify(res.json)).not.toContain("Mantle_Official");
    // Nothing was left unresolved, so the reviewer is told nothing — the preview already shows the
    // Korean link, which is the whole of what there would be to say.
    expect(json.x_paste.warnings).toEqual([]);
    expect(json.x_typefully.warnings).toEqual([]);
  });

  it("keeps the global url, and says so, when the linked post has no Korean version yet", async () => {
    // `loadXPostUrl` answers undefined for everything by default — the linked post is older than the
    // translation floor, or simply has not gone out yet.
    const deps = makeDeps([], [xRnd(`본문\n${GLOBAL_URL("111")}`)]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/x/x/emissions", undefined);
    const json = res.json as EmissionsJson;
    expect(json.x_paste.segments[0].text).toBe(`본문\n${GLOBAL_URL("111")}`);
    expect(json.x_paste.warnings).toEqual([krLinkNotice(1)]);
    // Both of the x channel's destinations carry it. `OutletCard` labels each warning with its
    // destination, so the reviewer reads the same sentence twice — exactly as an over-limit warning
    // already behaves on this channel.
    expect(json.x_typefully.warnings).toEqual([krLinkNotice(1)]);
  });

  it("substitutes only the links that resolve, and counts the ones that did not", async () => {
    const deps = makeDeps([], [xRnd(`${GLOBAL_URL("111")}\n${GLOBAL_URL("222")}\n${GLOBAL_URL("333")}`)]);
    deps.loadXPostUrl = async (id) => (id === "x:222" ? X_URL : undefined);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/x/x/emissions", undefined);
    const json = res.json as EmissionsJson;
    expect(json.x_paste.segments[0].text).toBe(`${GLOBAL_URL("111")}\n${X_URL}\n${GLOBAL_URL("333")}`);
    expect(json.x_paste.warnings).toEqual([krLinkNotice(2)]);
  });

  it("leaves a 공지's global link alone, and does not even look it up", async () => {
    const seen: string[] = [];
    const deps = makeDeps([], [rnd({ type: "announcement", channel: "telegram", text: `본문\n${GLOBAL_URL("111")}` })]);
    deps.loadXPostUrl = async (id) => {
      seen.push(id);
      return X_URL;
    };
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions", undefined);
    const json = res.json as EmissionsJson;
    expect(json.telegram_paste.segments[0].text).toContain(GLOBAL_URL("111"));
    expect(json.telegram_paste.warnings).toEqual([]);
    // The one lookup is the CTA's, for this rendering's own item. A 공지 is rewritten copy, not a
    // near-verbatim translation, so the link it carries is one we chose to put there.
    expect(seen).toEqual(["x:1"]);
  });

  it("resolves the LINKED post's item, not the rendering's own", async () => {
    const seen: string[] = [];
    const deps = makeDeps([], [xRnd(`본문 ${GLOBAL_URL("111")}`, "x:7")]);
    deps.loadXPostUrl = async (id) => {
      seen.push(id);
      return undefined;
    };
    await handleApi(deps, "GET", "/api/renderings/x%3A7/x/x/emissions", undefined);
    expect(seen).toEqual(["x:111"]);
  });

  /**
   * The notice joins a destination's warnings rather than replacing them — an over-limit `x` post
   * whose link is also unresolved has two things wrong with it, and the reviewer needs both.
   */
  it("prepends the notice to warnings the emitter itself produced", async () => {
    const deps = makeDeps([], [xRnd(`${"가".repeat(200)}\n${GLOBAL_URL("111")}`)]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/x/x/emissions", undefined);
    const json = res.json as EmissionsJson;
    for (const destination of ["x_paste", "x_typefully"]) {
      expect(json[destination].warnings).toHaveLength(2);
      expect(json[destination].warnings[0]).toBe(krLinkNotice(1));
      expect(json[destination].warnings[1]).toContain("초과");
    }
  });

  /**
   * The per-room route carries it too — wired separately from the group route above, and the reason
   * this is its own test: a rewrite landing only on the group route would leave every assertion
   * above green while the [복사] a human actually uses on a forked row still handed over the English
   * link.
   */
  it("rewrites a forked room's own copy on the per-room route", async () => {
    const deps = makeDeps([]);
    deps.loadXPostUrl = async (id) => (id === "x:111" ? X_URL : undefined);
    deps.loadBoard = async () => ({
      itemId: "x:1",
      unconverted: [],
      groups: [
        {
          type: "x" as const,
          channel: "x" as const,
          text: `그룹 ${GLOBAL_URL("999")}`,
          status: "approved" as const,
          addableOutletIds: [],
          rows: [
            { outletId: "x-post", label: "X", delivery: "manual" as const, forked: true, status: "approved" as const, text: `방 전용 ${GLOBAL_URL("111")} ${GLOBAL_URL("222")}`, siblingIndex: 1, siblingCount: 1 },
          ],
        },
      ],
    });
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/x/x/emissions/x-post", undefined);
    expect(res.status).toBe(200);
    const json = res.json as EmissionsJson;
    // The room's own text, rewritten — and the group's untouched link nowhere in it.
    expect(json.x_paste.segments[0].text).toBe(`방 전용 ${X_URL} ${GLOBAL_URL("222")}`);
    expect(json.x_paste.warnings).toEqual([krLinkNotice(1)]);
  });

  /** Two links, two Korean posts: each is resolved on its own, not by the first answer for all. */
  it("resolves each link independently", async () => {
    const deps = makeDeps([], [xRnd(`${GLOBAL_URL("111")}\n${GLOBAL_URL("222")}`)]);
    deps.loadXPostUrl = async (id) => (id === "x:111" ? X_URL : id === "x:222" ? KR_URL_2 : undefined);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/x/x/emissions", undefined);
    const json = res.json as EmissionsJson;
    expect(json.x_paste.segments[0].text).toBe(`${X_URL}\n${KR_URL_2}`);
    expect(json.x_paste.warnings).toEqual([]);
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
    expect(spy.sends).toEqual([{ itemId: "x:1", type: "announcement", outletId: "tg-dev", opts: { resend: false, pin: false } }]);
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

  /**
   * `deps.sendToOutlet` absent — the hosted route set with sends still closed (`createDeps.ts`).
   * Checked before the use-case, the same "refuse at the route" shape `convert-prepare` uses for
   * `prepareConversionRun`, but with a Korean reason and the rebuilt board rather than a bare 404:
   * unlike that route (never present on hosted), this one is only temporarily closed and an operator
   * can still click [발송] on it, so the refusal has to say why.
   */
  it("POST send answers with a reason and the board when sends are closed, rather than reaching the use case", async () => {
    const { spy, d } = spied();
    d.sendToOutlet = undefined;
    const res = await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", undefined);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: "발송이 아직 열려 있지 않습니다 — 1차·2차 승인이 자리잡으면 팀이 직접 엽니다.",
      board: { itemId: "x:1", groups: [], unconverted: [] },
    });
    expect(spy.sends).toEqual([]);
  });

  it("POST send forwards the body's pin flag", async () => {
    const { spy, d } = spied();
    await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", { pin: true });
    expect(spy.sends).toEqual([{ itemId: "x:1", type: "announcement", outletId: "tg-dev", opts: { resend: false, pin: true } }]);
  });

  it("POST send without a body pins nothing", async () => {
    const { spy, d } = spied();
    await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", undefined);
    expect(spy.sends).toEqual([{ itemId: "x:1", type: "announcement", outletId: "tg-dev", opts: { resend: false, pin: false } }]);
  });

  /** A live post that could not be pinned is still a live post: 200, and the board repaints. */
  it("POST send that posted but could not pin answers 200 with the reason", async () => {
    const { d } = spied({ send: () => ({ sent: 1, failed: 0, error: "맨틀 한국 데브방 (tg-dev): 글은 올라갔지만 고정하지 못했습니다" }) });
    const res = await handleApi(d, "POST", "/api/outlets/x%3A1/announcement/tg-dev/send", { pin: true });
    expect(res.status ?? 200).toBe(200);
    expect((res.json as { error?: string }).error).toContain("고정하지 못했습니다");
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
        return { renderings: [rnd(), rnd()], warnings: [], skippedPosted: [] };
      },
    } as unknown as ApiDeps["formatVariants"];

    const res = await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"], channels: ["telegram"] });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ rendered: 2, warnings: [], alreadyPosted: false });
    expect(spy.formats).toEqual([{ ids: ["x:1"], types: ["announcement"], channels: ["telegram"] }]);
  });

  it("omits channels from the selector when the request does not name any (FormatVariants applies its own defaults)", async () => {
    const { spy, d } = spied();
    d.formatVariants = {
      run: async (input: unknown) => {
        spy.formats.push(input);
        return { renderings: [], warnings: [], skippedPosted: [] };
      },
    } as unknown as ApiDeps["formatVariants"];

    await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"] });

    expect(spy.formats).toEqual([{ ids: ["x:1"], types: ["announcement"], channels: undefined }]);
  });

  it("surfaces FormatVariants' warnings in the response, alongside the rendered count", async () => {
    const { d } = spied();
    const warning = { itemId: "x:1", type: "announcement" as const, channel: "telegram" as const, messages: ["over the X limit"] };
    d.formatVariants = { run: async () => ({ renderings: [rnd()], warnings: [warning], skippedPosted: [] }) } as unknown as ApiDeps["formatVariants"];

    const res = await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"] });

    expect(res.json).toEqual({ rendered: 1, warnings: [warning], alreadyPosted: false });
  });

  /**
   * `FormatVariants` refuses to re-render an item whose 1차 translation is `posted`, for every
   * caller — this route included. A 200 with `rendered: 0` and nothing else would read as a broken
   * button, so the refusal is on the reply: the request was well-formed and the item really is
   * finished, which is not a 400.
   */
  it("reports a refusal on a finished item rather than an unexplained zero", async () => {
    const { d } = spied();
    d.formatVariants = {
      run: async () => ({ renderings: [], warnings: [], skippedPosted: ["x:1"] }),
    } as unknown as ApiDeps["formatVariants"];

    const res = await handleApi(d, "POST", "/api/items/x%3A1/format", { types: ["announcement"] });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ rendered: 0, warnings: [], alreadyPosted: true });
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

describe("POST /api/intake/x", () => {
  it("collects the linked thread and answers with the outcome and the refreshed pending list", async () => {
    const d = makeDeps([]);
    d.collectLinkedThread = {
      run: async (url: string) => {
        expect(url).toBe("https://x.com/someone/status/7");
        return { itemId: "x:7", tweets: 3, outcome: "collected" as const };
      },
    } as unknown as ApiDeps["collectLinkedThread"];
    d.loadIntakePending = async () => [
      { itemId: "x:7", text: "hello", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" as const },
    ];

    const res = await handleApi(d, "POST", "/api/intake/x", { url: "https://x.com/someone/status/7" });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      itemId: "x:7",
      tweets: 3,
      outcome: "collected",
      pending: [{ itemId: "x:7", text: "hello", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" }],
    });
  });

  it("turns a use-case refusal into a 400 carrying its message", async () => {
    const d = makeDeps([]);
    d.collectLinkedThread = {
      run: async () => { throw new Error("이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다"); },
    } as unknown as ApiDeps["collectLinkedThread"];

    const res = await handleApi(d, "POST", "/api/intake/x", { url: "https://x.com/someone/status/7" });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다" });
  });

  it("400s with a reason when the deployment has no X credentials", async () => {
    const d = makeDeps([]);
    d.collectLinkedThread = undefined;

    const res = await handleApi(d, "POST", "/api/intake/x", { url: "https://x.com/someone/status/7" });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: INTAKE_DISABLED_MESSAGE });
  });

  it("400s on a missing or non-string url before reaching the use case", async () => {
    let called = false;
    const d = makeDeps([]);
    d.collectLinkedThread = {
      run: async () => { called = true; throw new Error("unreachable"); },
    } as unknown as ApiDeps["collectLinkedThread"];

    const res = await handleApi(d, "POST", "/api/intake/x", { url: 42 });

    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe("GET /api/intake/pending", () => {
  it("answers the pending list even where intake itself is closed", async () => {
    // The list reads the database only. A deployment with no X key cannot take a link, but the
    // operator can still see what is queued — so this route is not gated on the credential.
    const d = makeDeps([]);
    d.collectLinkedThread = undefined;
    d.loadIntakePending = async () => [
      { itemId: "x:9", text: "queued", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" as const },
    ];

    const res = await handleApi(d, "GET", "/api/intake/pending", undefined);

    expect(res.status).toBe(200);
    expect(res.json).toEqual([{ itemId: "x:9", text: "queued", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" }]);
  });
});
