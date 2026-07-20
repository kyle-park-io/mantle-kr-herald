// src/adapters/web/apiHandlers.ts
import type { Translation } from "../../domain/translation/models";
import type { TranslationStore } from "../../ports/TranslationStore";
import type { SaveTranslation } from "../../app/SaveTranslation";
import type { PublishTranslations } from "../../app/PublishTranslations";
import type { ChannelRendering, Channel } from "../../domain/formatting/models";
import type { ConversionType } from "../../domain/conversion/models";
import type { FormattingStore } from "../../ports/FormattingStore";
import type { ConversionStore } from "../../ports/ConversionStore";
import type { SaveRendering } from "../../app/SaveRendering";
import type { ApproveRendering } from "../../app/ApproveRendering";
import type { StorageMode } from "../../storage/mode";

export interface StatusView {
  storageMode: StorageMode;
  funnel: { collected: number; translated: number; converted: number; rendered: number; published: number };
  sync: { published: number; unsynced: number; stale: number };
}

export interface PublishStateRow {
  itemId: string;
  status: string;
  target: string;
  url?: string;
  remoteId?: string;
  fileName?: string;
}

export interface ApiResult {
  status: number;
  json: unknown;
}

export interface ApiDeps {
  translationStore: TranslationStore;
  saveTranslation: SaveTranslation;
  buildPublisher: (target: string | undefined) => Promise<PublishTranslations>;
  storageMode: StorageMode;
  formattingStore: FormattingStore;
  conversionStore: ConversionStore;
  saveRendering: SaveRendering;
  approveRendering: ApproveRendering;
  loadStatus: () => Promise<StatusView>;
  loadPublishState: () => Promise<PublishStateRow[]>;
}

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
    return { status: 200, json: await deps.translationStore.loadAll() };
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
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText, approve: false });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "approve") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText: existing.koreanText, approve: true });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }
  }

  if (method === "POST" && segments.length === 2 && segments[1] === "publish") {
    const target = (body as { target?: string })?.target;
    const pub = await deps.buildPublisher(target);
    return { status: 200, json: await pub.run() };
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
    }
  }

  return { status: 404, json: { error: "not found" } };
}
