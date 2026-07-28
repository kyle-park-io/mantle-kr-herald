// src/adapters/web/apiHandlers.ts
import type { Translation } from "../../domain/translation/models";
import type { TranslationStore } from "../../ports/TranslationStore";
import type { SaveTranslation } from "../../app/SaveTranslation";
import type { PublishResult } from "../../app/PublishTranslations";
import type { ChannelRendering, Channel } from "../../domain/formatting/models";
import type { ConversionType } from "../../domain/conversion/models";
import type { FormattingStore } from "../../ports/FormattingStore";
import type { ConversionStore } from "../../ports/ConversionStore";
import type { SaveRendering } from "../../app/SaveRendering";
import type { ApproveRendering } from "../../app/ApproveRendering";
import type { StorageMode } from "../../storage/mode";
import { emitAll } from "../../domain/formatting/emitters";
import type { ApiTranslation } from "./attachKind";
import type { BoardView } from "./board";
import type { SaveOutletOverride } from "../../app/SaveOutletOverride";
import type { MarkDelivery } from "../../app/MarkDelivery";

/** Whether a given integration's credentials are present in the env (independent of storage mode). */
export interface IntegrationStatus {
  key: string;
  label: string;
  group: "collect" | "publish" | "send" | "data";
  configured: boolean;
}

export interface StatusView {
  storageMode: StorageMode;
  funnel: { collected: number; translated: number; converted: number; rendered: number; published: number };
  sync: { synced: number; needsRepublish: number; unpublished: number };
  availableTargets: ("local" | "google" | "lark")[];
  integrations: IntegrationStatus[];
}

export interface PublishStateRow {
  itemId: string;
  status: string;
  target: string;
  url?: string;
  remoteId?: string;
  fileName?: string;
  folderUrl?: string; // NEW — "open folder" for Google/Lark
  fileUrl?: string; // NEW — "open file" for Google/Lark
  /** Whether this row is up to date with the item's current status + content (else: needs republish). */
  synced?: boolean;
}

export interface ApiResult {
  status: number;
  json: unknown;
}

export interface ApiDeps {
  translationStore: TranslationStore;
  saveTranslation: SaveTranslation;
  publishOne: (id: string, target: string) => Promise<PublishResult>;
  storageMode: StorageMode;
  formattingStore: FormattingStore;
  conversionStore: ConversionStore;
  saveRendering: SaveRendering;
  approveRendering: ApproveRendering;
  loadStatus: () => Promise<StatusView>;
  loadPublishState: () => Promise<PublishStateRow[]>;
  loadTranslations: () => Promise<ApiTranslation[]>;
  xMaxWeighted: number;
  loadBoard: (itemId: string) => Promise<BoardView>;
  saveOutletOverride: SaveOutletOverride;
  markDelivery: MarkDelivery;
  sendToOutlet: (itemId: string, type: string, outletId: string) => Promise<{ sent: number; failed: number; error?: string }>;
}

/** Board mutations answer with the whole rebuilt board: one round trip, no stale rows on screen. */
type BoardReply = { board: BoardView } & Record<string, unknown>;

async function findById(store: TranslationStore, id: string): Promise<Translation | undefined> {
  return (await store.loadAll()).find((t) => t.itemId === id);
}

export async function handleApi(deps: ApiDeps, method: string, path: string, body: unknown): Promise<ApiResult> {
  const segments = path.split("/").filter(Boolean); // ["api", "translations", ...]
  if (segments[0] !== "api") return { status: 404, json: { error: "not found" } };

  // The frontend cannot know the server's storage mode, and it decides which publish targets to
  // offer — a local-mode dashboard defaulting to "google" would fail on every first click.
  if (method === "GET" && segments.length === 2 && segments[1] === "config") {
    return { status: 200, json: { storageMode: deps.storageMode } };
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "status") {
    return { status: 200, json: await deps.loadStatus() };
  }

  if (method === "GET" && segments.length === 3 && segments[1] === "publish" && segments[2] === "state") {
    return { status: 200, json: await deps.loadPublishState() };
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "translations") {
    return { status: 200, json: await deps.loadTranslations() };
  }

  if (segments[1] === "translations" && segments.length >= 3) {
    const id = decodeURIComponent(segments[2]);
    const existing = await findById(deps.translationStore, id);

    if (method === "PUT" && segments.length === 3) {
      const koreanText = (body as { koreanText?: unknown })?.koreanText;
      if (typeof koreanText !== "string" || koreanText.trim() === "") {
        return { status: 400, json: { error: "koreanText required" } };
      }
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText, approve: false, isReply: existing.isReply, refUrl: existing.refUrl });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "approve") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText: existing.koreanText, approve: true, isReply: existing.isReply, refUrl: existing.refUrl });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "publish") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      const target = (body as { target?: unknown })?.target;
      if (typeof target !== "string" || target === "") return { status: 400, json: { error: "target required" } };
      return { status: 200, json: await deps.publishOne(existing.itemId, target) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "unapprove") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText: existing.koreanText, approve: false, isReply: existing.isReply, refUrl: existing.refUrl });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }
  }

  if (segments[1] === "renderings") {
    if (method === "GET" && segments.length === 2) {
      const [renderings, variants] = await Promise.all([deps.formattingStore.loadAll(), deps.conversionStore.loadAll()]);
      const convertedByKey = new Map(variants.map((v) => [`${v.itemId}:${v.type}`, v.convertedText]));
      const enriched = renderings.map((r) => ({ ...r, convertedText: convertedByKey.get(`${r.itemId}:${r.type}`) ?? "" }));
      return { status: 200, json: enriched };
    }

    if (segments.length >= 5) {
      const itemId = decodeURIComponent(segments[2]);
      const type = segments[3] as ConversionType;
      const channel = segments[4] as Channel;

      if (method === "PUT" && segments.length === 5) {
        const text = (body as { text?: unknown })?.text;
        if (typeof text !== "string" || text.trim() === "") return { status: 400, json: { error: "text required" } };
        const existing = (await deps.formattingStore.loadAll()).find(
          (r) => r.itemId === itemId && r.type === type && r.channel === channel,
        );
        if (!existing) return { status: 404, json: { error: "not found" } };
        await deps.saveRendering.run({ itemId, type, channel, text });
        const updated = (await deps.formattingStore.loadAll()).find(
          (r) => r.itemId === itemId && r.type === type && r.channel === channel,
        );
        return { status: 200, json: updated };
      }

      if (method === "POST" && segments.length === 6 && segments[5] === "approve") {
        const updated = await deps.approveRendering.run({ itemId, type, channel });
        if (!updated) return { status: 404, json: { error: "not found" } };
        return { status: 200, json: updated };
      }

      if (method === "GET" && segments.length === 6 && segments[5] === "emissions") {
        const existing = (await deps.formattingStore.loadAll()).find(
          (r) => r.itemId === itemId && r.type === type && r.channel === channel,
        );
        if (!existing) return { status: 404, json: { error: "not found" } };
        return { status: 200, json: emitAll(existing.text, channel, deps.xMaxWeighted) };
      }

      // `…/emissions/:outletId` — the spelling *that room* receives. A forked room's copy is its
      // own, so emitting the group rendering would hand a human the wrong text to paste into a
      // live room. The resolved text is read off the board rather than re-resolved here, so this
      // route and the row on screen can never disagree about what the room's copy is.
      if (method === "GET" && segments.length === 7 && segments[5] === "emissions") {
        const board = await deps.loadBoard(itemId);
        const row = board.groups
          .find((g) => g.type === type && g.channel === channel)
          ?.rows.find((r) => r.outletId === segments[6]);
        if (!row) return { status: 404, json: { error: "not found" } };
        return { status: 200, json: emitAll(row.text, channel, deps.xMaxWeighted) };
      }
    }
  }

  if (method === "GET" && segments.length === 4 && segments[1] === "items" && segments[3] === "board") {
    return { status: 200, json: await deps.loadBoard(decodeURIComponent(segments[2])) };
  }

  if (segments[1] === "outlets" && segments.length >= 5) {
    const itemId = decodeURIComponent(segments[2]);
    const type = segments[3];
    const outletId = segments[4];
    // `SaveOutletOverride` and `MarkDelivery` refuse the moves that would corrupt the ledger
    // (an unknown room, ticking an auto room, unticking a bot's `sent` row). Those refusals are the
    // operator asking for something impossible, not a server fault — 400 with the reason, so the
    // dashboard can show it, rather than the 500 an uncaught throw would produce.
    const reply = async (extra: Record<string, unknown> = {}): Promise<ApiResult> => ({
      status: 200,
      json: { ...extra, board: await deps.loadBoard(itemId) } satisfies BoardReply,
    });
    const refuse = (err: unknown): ApiResult => ({
      status: 400,
      json: { error: err instanceof Error ? err.message : String(err) },
    });

    if (method === "PUT" && segments.length === 5) {
      const b = (body ?? {}) as { text?: unknown; approve?: unknown; revert?: unknown };
      const input =
        b.revert === true ? { revert: true }
        : b.approve === true ? { approve: true }
        : typeof b.text === "string" && b.text.trim() !== "" ? { text: b.text }
        : undefined;
      if (!input) return { status: 400, json: { error: "text, approve or revert required" } };
      try {
        const override = await deps.saveOutletOverride.run({ itemId, type, outletId, ...input });
        return await reply({ override: override ?? null });
      } catch (err) {
        return refuse(err);
      }
    }

    if (method === "POST" && segments.length === 6 && segments[5] === "send") {
      const result = await deps.sendToOutlet(itemId, type, outletId);
      // Nothing went out and there is a reason for it (unconfigured room, manual room, sender
      // error): 400 so the dashboard's `json()` helper raises it. A partial send still answers
      // 200 with the board — something did reach a live room, and the rows must reflect that.
      if (result.sent === 0 && result.error) return { status: 400, json: { error: result.error } };
      return await reply({ ...result });
    }

    if (method === "POST" && segments.length === 6 && segments[5] === "mark") {
      const delivered = (body as { delivered?: unknown })?.delivered;
      if (typeof delivered !== "boolean") return { status: 400, json: { error: "delivered (boolean) required" } };
      try {
        await deps.markDelivery.run({ itemId, type, outletId, delivered });
        return await reply();
      } catch (err) {
        return refuse(err);
      }
    }
  }

  return { status: 404, json: { error: "not found" } };
}
