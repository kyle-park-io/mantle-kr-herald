// src/adapters/web/apiHandlers.ts
import type { Translation } from "../../domain/translation/models";
import type { TranslationStore } from "../../ports/TranslationStore";
import type { SaveTranslation } from "../../app/SaveTranslation";
import type { PublishResult } from "../../app/PublishTranslations";
import { ALL_CHANNELS, type ChannelRendering, type Channel } from "../../domain/formatting/models";
import { ALL_TYPES, type ConversionType } from "../../domain/conversion/models";
import type { FormattingStore } from "../../ports/FormattingStore";
import type { ConversionStore } from "../../ports/ConversionStore";
import type { SaveRendering } from "../../app/SaveRendering";
import type { ApproveRendering } from "../../app/ApproveRendering";
import type { StorageMode } from "../../storage/mode";
import { emitAll } from "../../domain/formatting/emitters";
import type { ApiTranslation } from "./attachKind";
import type { SheetLink } from "../../config";
import type { BoardView } from "./board";
import type { SaveOutletOverride } from "../../app/SaveOutletOverride";
import type { MarkDelivery } from "../../app/MarkDelivery";
import type { PrepareConversionRun } from "../../app/PrepareConversionRun";
import type { FormatVariants } from "../../app/FormatVariants";
import type { PublishingQuota } from "../send/TypefullyQuota";

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
  /** Header links to the team workbooks. A key is absent when its id is not configured. */
  sheetLinks: { data?: SheetLink; qa?: SheetLink };
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
  reconcilePublished: () => Promise<{ reconciled: number; pending: number; error?: string }>;
  sendToOutlet: (itemId: string, type: string, outletId: string, resend?: boolean) => Promise<{ sent: number; failed: number; error?: string }>;
  /** Writes a conversion worksheet for the dashboard; the local agent still fills it in. */
  prepareConversionRun: PrepareConversionRun;
  /** Pure code — unlike conversion, the dashboard can run this one itself. */
  formatVariants: FormatVariants;
  /**
   * The Typefully publishing quota for the banner, plus `inFlight` — rooms already sent to but not
   * yet confirmed published, the same count the send gate (`SendChannels`) subtracts from
   * `quota.remaining`. The banner needs both so it can show the number the gate actually enforces
   * rather than the raw account total. `error` when the quota itself could not be read.
   */
  loadQuota: () => Promise<{ quota?: PublishingQuota; inFlight?: number; error?: string }>;
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

  // Account-wide, not per item — and deliberately not a field on BoardView: board loads are
  // frequent and the social-set bucket is the smallest rate limit we measured (500/hr).
  if (method === "GET" && segments.length === 3 && segments[1] === "typefully" && segments[2] === "quota") {
    return { status: 200, json: await deps.loadQuota() };
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
      const [renderings, variants, translations] = await Promise.all([
        deps.formattingStore.loadAll(),
        deps.conversionStore.loadAll(),
        // For `postedAt`/`kind` only. The 2차 list is per *item*, like 1차, so it shows the same
        // date prefix and 포스트/아티클 badge — which live on the source item, not the rendering.
        deps.loadTranslations(),
      ]);
      const convertedByKey = new Map(variants.map((v) => [`${v.itemId}:${v.type}`, v.convertedText]));
      const sourceById = new Map(translations.map((t) => [t.itemId, t] as const));
      const enriched = renderings.map((r) => ({
        ...r,
        convertedText: convertedByKey.get(`${r.itemId}:${r.type}`) ?? "",
        postedAt: sourceById.get(r.itemId)?.postedAt,
        kind: sourceById.get(r.itemId)?.kind,
      }));
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

      // Two routes rather than one with a body flag, mirroring `/api/translations/:id/{approve,unapprove}`.
      if (method === "POST" && segments.length === 6 && (segments[5] === "approve" || segments[5] === "unapprove")) {
        const updated = await deps.approveRendering.run({ itemId, type, channel, approve: segments[5] === "approve" });
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

  if (segments[1] === "items" && segments.length === 4) {
    const itemId = decodeURIComponent(segments[2]);

    // Board-wide, not per item: one Typefully pass answers for every scheduled draft, and the
    // board reloads from the rebuilt view either way.
    if (method === "POST" && segments[3] === "reconcile") {
      const result = await deps.reconcilePublished();
      if (result.error) return { status: 400, json: { error: result.error, board: await deps.loadBoard(itemId) } };
      return { status: 200, json: { ...result, board: await deps.loadBoard(itemId) } };
    }

    if (method === "GET" && segments[3] === "board") {
      return { status: 200, json: await deps.loadBoard(itemId) };
    }

    // The board cannot convert (no Claude API, zod-only runtime) — this runs `convert:prepare` and
    // hands back where the worksheet landed. Filling it is the local agent's job; the operator asks
    // for that separately, which is why the reply carries a path rather than converted text.
    if (method === "POST" && segments[3] === "convert-prepare") {
      const typesRaw = (body as { types?: unknown })?.types;
      if (!Array.isArray(typesRaw) || typesRaw.length === 0) {
        return { status: 400, json: { error: "types (non-empty array) required" } };
      }
      const invalid = typesRaw.filter((t) => typeof t !== "string" || !ALL_TYPES.includes(t as ConversionType));
      if (invalid.length > 0) return { status: 400, json: { error: `invalid types: ${invalid.join(", ")}` } };
      const result = await deps.prepareConversionRun.run({ itemId, types: typesRaw as ConversionType[] });
      return { status: 200, json: result };
    }

    // Unlike conversion, `FormatVariants` is pure code — this button really does the work, and
    // overwrites whatever was stored (including an edit or an approval) for the chosen (type,
    // channel) pairs. The dashboard is expected to confirm that loss with the operator before
    // calling this; the route itself does not ask twice.
    if (method === "POST" && segments[3] === "format") {
      const b = (body ?? {}) as { types?: unknown; channels?: unknown };
      const typesRaw = b.types;
      if (!Array.isArray(typesRaw) || typesRaw.length === 0) {
        return { status: 400, json: { error: "types (non-empty array) required" } };
      }
      const invalidTypes = typesRaw.filter((t) => typeof t !== "string" || !ALL_TYPES.includes(t as ConversionType));
      if (invalidTypes.length > 0) return { status: 400, json: { error: `invalid types: ${invalidTypes.join(", ")}` } };

      let channels: Channel[] | undefined;
      if (b.channels !== undefined) {
        // Same non-empty rule as `types` just above: `FormatVariants` reads `channels` with `??`,
        // so an empty array is never replaced by its per-type defaults — it would 200 and silently
        // render nothing, rather than reject like every other malformed request on this route.
        if (!Array.isArray(b.channels) || b.channels.length === 0) {
          return { status: 400, json: { error: "channels, if present, must be a non-empty array" } };
        }
        const invalidChannels = b.channels.filter((c) => typeof c !== "string" || !ALL_CHANNELS.includes(c as Channel));
        if (invalidChannels.length > 0) return { status: 400, json: { error: `invalid channels: ${invalidChannels.join(", ")}` } };
        channels = b.channels as Channel[];
      }

      const { renderings, warnings } = await deps.formatVariants.run({ ids: [itemId], types: typesRaw as ConversionType[], channels });
      return { status: 200, json: { rendered: renderings.length, warnings } };
    }
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
      // `approve` is matched on both booleans, not truthiness: `false` is the 승인 취소 request, and
      // reading it as "absent" would fall through to the text branch and 400 on a valid call.
      const input =
        b.revert === true ? { revert: true }
        : typeof b.approve === "boolean" ? { approve: b.approve }
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
      // `resend` is opt-in per call rather than a separate route: it is the same delivery to the
      // same room, differing only in that the ledger already holds a row for it.
      const resend = (body as { resend?: unknown })?.resend === true;
      const result = await deps.sendToOutlet(itemId, type, outletId, resend);
      // Nothing went out and there is a reason for it (unconfigured room, manual room, sender
      // error): 400 so the dashboard's `json()` helper raises it. A partial send still answers
      // 200 with the board — something did reach a live room, and the rows must reflect that.
      //
      // The refusal carries the rebuilt board too. The commonest one is "already delivered to this
      // room", which means the server's view has moved on — someone ran `pnpm send:channels` in a
      // terminal while this board was open. Answering with the error alone leaves the row still
      // offering [발송] for something already sent, so the screen never self-corrects.
      if (result.sent === 0 && result.error) {
        return { status: 400, json: { error: result.error, board: await deps.loadBoard(itemId) } };
      }
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
