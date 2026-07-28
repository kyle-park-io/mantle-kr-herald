import "./registerErrorHandler";
// src/cli/serve.ts
import { join } from "node:path";
import { startServer } from "../adapters/web/HttpServer";
import type { ApiDeps } from "../adapters/web/apiHandlers";
import type { StatusView, PublishStateRow, IntegrationStatus } from "../adapters/web/apiHandlers";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { SaveTranslation } from "../app/SaveTranslation";
import { PublishTranslations } from "../app/PublishTranslations";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonOutletOverrideStore } from "../adapters/store/JsonOutletOverrideStore";
import { JsonDeliveryLedger } from "../adapters/store/JsonDeliveryLedger";
import { SaveRendering } from "../app/SaveRendering";
import { ApproveRendering } from "../app/ApproveRendering";
import { SaveOutletOverride } from "../app/SaveOutletOverride";
import { MarkDelivery } from "../app/MarkDelivery";
import { SendChannels } from "../app/SendChannels";
import { buildBoard, type BoardView } from "../adapters/web/board";
import { deliveredByChannelSender, outletById, outletsForChannel } from "../domain/outlet/models";
import { createSenders } from "./channelSenders";
import { buildRecorder } from "./recorder";
import { buildArchiver } from "./archiver";
import type { SendableChannel } from "../domain/send/channels";
import {
  loadStorageMode,
  loadGoogleAuthConfig,
  loadGoogleDriveConfig,
  loadLarkDriveConfig,
  loadConfig,
  loadLarkAppConfig,
  loadGoogleSheetConfig,
  loadTelegramConfig,
  loadTelegramChatIds,
  loadTypefullyConfig,
  loadXMaxWeighted,
} from "../config";
import { createUploaders, resolveTargets } from "./uploaders";
import type { PublishResult } from "../app/PublishTranslations";
import { REPO_ROOT, paths } from "../paths";
import { buildLineage } from "./lineage-wiring";
import { XContentSource } from "../adapters/content/XContentSource";
import { LarkContentSource } from "../adapters/content/LarkContentSource";
import { CompositeContentSource } from "../adapters/content/CompositeContentSource";
import { syncSummary } from "../status/sync";
import { renderApproved, renderReview } from "../domain/publish/renderers";
import { contentHash, isStale } from "../domain/publish/syncLedger";
import type { Translation } from "../domain/translation/models";
import { publishRowLinks, type PublishLinkConfig } from "../adapters/web/publishLinks";
import { attachKind } from "../adapters/web/attachKind";

const port = Number(process.env.PORT) || 5757;
const translationStore = new JsonTranslationStore(paths.translationsDir);
const publishStore = new JsonPublishStore(paths.publishDir);
const saveTranslation = new SaveTranslation(translationStore, new JsonFewShotStore(paths.translationConfigDir), undefined, buildLineage());
const formattingStore = new JsonFormattingStore(paths.formattedDir);
const conversionStore = new JsonConversionStore(paths.variantsDir);
// Same directories the CLI uses, so `send:channels` and the dashboard read one ledger, not two.
const overrideStore = new JsonOutletOverrideStore(paths.formattedDir);
const deliveryLedger = new JsonDeliveryLedger(paths.publishDir);

const storageMode = loadStorageMode();

const usableTargets = ((): ("local" | "google" | "lark")[] => {
  const targets: ("local" | "google" | "lark")[] = ["local"];
  if (storageMode === "cloud") {
    try {
      loadGoogleAuthConfig();
      loadGoogleDriveConfig();
      targets.push("google");
    } catch {
      /* Google not configured — omit */
    }
    try {
      loadLarkDriveConfig();
      targets.push("lark");
    } catch {
      /* Lark not configured — omit */
    }
  }
  return targets;
})();

/** Credential presence per integration (env only, no live calls) — for the dashboard's env panel. */
const integrations: IntegrationStatus[] = ((): IntegrationStatus[] => {
  const probe = (fn: () => unknown): boolean => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };
  return [
    { key: "twitterapi", label: "X (twitterapi.io)", group: "collect", configured: probe(loadConfig) },
    { key: "lark_app", label: "Lark 앱", group: "collect", configured: probe(loadLarkAppConfig) },
    { key: "local", label: "로컬 폴더", group: "publish", configured: true },
    {
      key: "google_drive",
      label: "Google Drive",
      group: "publish",
      configured: probe(() => {
        loadGoogleAuthConfig();
        loadGoogleDriveConfig();
      }),
    },
    { key: "lark_drive", label: "Lark Drive", group: "publish", configured: probe(loadLarkDriveConfig) },
    {
      key: "telegram",
      label: "Telegram",
      group: "send",
      // A bot token alone delivers nothing: `send:channels` posts per room, so at least one room's
      // chat id has to resolve (a per-room `TELEGRAM_CHAT_ID_*`, or the legacy fallback).
      configured: probe(() => {
        loadTelegramConfig();
        if (Object.keys(loadTelegramChatIds()).length === 0) throw new Error("no Telegram room chat id configured");
      }),
    },
    { key: "typefully", label: "Typefully", group: "send", configured: probe(loadTypefullyConfig) },
    { key: "google_sheets", label: "Google Sheets", group: "data", configured: probe(loadGoogleSheetConfig) },
  ];
})();

const linkCfg: PublishLinkConfig = {};
if (storageMode === "cloud") {
  try {
    const g = loadGoogleDriveConfig();
    linkCfg.google = { reviewFolderId: g.reviewFolderId, approvedFolderId: g.approvedFolderId };
  } catch {
    /* Google not configured — no Google folder links */
  }
  try {
    const l = loadLarkDriveConfig();
    if (l.workspaceUrl) {
      linkCfg.lark = { workspaceUrl: l.workspaceUrl, reviewFolderToken: l.reviewFolderToken, approvedFolderToken: l.approvedFolderToken };
    }
  } catch {
    /* Lark not configured — no Lark links */
  }
}

const contentSource = new CompositeContentSource([
  new XContentSource(paths.xItems),
  new LarkContentSource(paths.larkItems),
]);

/** The exact bytes an uploader would send for a translation at its current status. */
const renderFor = (t: Translation): string => (t.status === "approved" ? renderApproved(t) : renderReview(t));

const loadStatus = async (): Promise<StatusView> => {
  const [collected, translations, variants, renderings, entries] = await Promise.all([
    contentSource.loadPending(new Set()),
    translationStore.loadAll(),
    conversionStore.loadAll(),
    formattingStore.loadAll(),
    publishStore.listEntries(),
  ]);
  const sync = syncSummary({ translations, entries, render: renderFor });
  return {
    storageMode,
    funnel: {
      collected: collected.length,
      translated: translations.length,
      converted: variants.length,
      rendered: renderings.length,
      published: entries.length,
    },
    sync,
    availableTargets: usableTargets,
    integrations,
  };
};

const publishOne = async (itemId: string, target: string): Promise<PublishResult> =>
  new PublishTranslations(
    translationStore,
    await createUploaders(resolveTargets(target, storageMode)),
    publishStore,
  ).run({ itemId });

const loadTranslations = async () =>
  attachKind(await translationStore.loadAll(), await contentSource.loadPending(new Set()));

const loadPublishState = async (): Promise<PublishStateRow[]> => {
  const [entries, translations] = await Promise.all([publishStore.listEntries(), translationStore.loadAll()]);
  const byId = new Map(translations.map((t) => [t.itemId, t] as const));
  return entries.map((e) => {
    // A row is synced when it matches the item's CURRENT status and current render; a status change
    // (review doc after approval) or an edit since upload flips it to "needs republish".
    const t = byId.get(e.itemId);
    const synced = t ? e.status === t.status && !isStale(e, contentHash(renderFor(t))) : undefined;
    return {
      itemId: e.itemId,
      status: e.status,
      target: e.target,
      url: e.url,
      remoteId: e.remoteId,
      fileName: e.fileName,
      synced,
      ...publishRowLinks({ target: e.target, status: e.status, url: e.url, remoteId: e.remoteId }, linkCfg),
    };
  });
};

const loadBoard = async (itemId: string): Promise<BoardView> => {
  const [renderings, overrides, deliveries] = await Promise.all([
    formattingStore.loadAll(),
    overrideStore.loadAll(),
    deliveryLedger.loadAll(),
  ]);
  return buildBoard(itemId, renderings, overrides, deliveries);
};

const isSendableChannel = (c: string): c is SendableChannel => c === "telegram" || c === "x";

/**
 * The board's per-row [발송]: one item, one type, one room. `SendChannels` is the same use case the
 * CLI runs, narrowed on all three axes — the row the operator clicked must not also push the item's
 * other approved copy, or the same copy into the room next door.
 *
 * Every refusal comes back as `error` rather than as a throw: the dashboard has to name the reason,
 * and "the room has no chat id" is an install state, not a server fault. Naming the room explicitly
 * also lifts `SendChannels`' first-delivery guard, which is correct here — a human clicked it.
 */
const sendToOutlet = async (itemId: string, type: string, outletId: string): Promise<{ sent: number; failed: number; error?: string }> => {
  const outlet = outletById(outletId);
  if (!outlet) return { sent: 0, failed: 0, error: `unknown outlet: ${outletId}` };
  if (!deliveredByChannelSender(outlet) || !isSendableChannel(outlet.channel)) {
    return { sent: 0, failed: 0, error: `${outlet.label} (${outlet.id}) is not posted by a bot — copy the text, paste it, and tick 전달함` };
  }
  const channel = outlet.channel;
  const chatIds = loadTelegramChatIds();
  if (outlet.chatIdEnv && !chatIds[outlet.id]) {
    return { sent: 0, failed: 0, error: `${outlet.label} (${outlet.id}): ${outlet.chatIdEnv} is not set` };
  }

  try {
    const [record, archive] = await Promise.all([buildRecorder(), buildArchiver()]);
    const result = await new SendChannels(
      formattingStore,
      createSenders([channel]),
      deliveryLedger,
      record,
      archive,
      undefined,
      loadXMaxWeighted(),
      outletsForChannel,
      chatIds,
    ).run({ targets: [channel], ids: new Set([itemId]), types: [type], outletIds: [outletId] });

    // `sent 0` on its own tells the reviewer nothing, so every zero-send outcome carries a reason.
    // Kept in the same English as the `MarkDelivery` / `SaveOutletOverride` refusals, which surface
    // through the same dashboard error path.
    if (result.sent === 0) {
      const reason =
        result.failed > 0 ? "the send failed — check the server log"
        : result.skipped > 0 ? "already delivered to this room"
        : result.unconfigured > 0 ? `${result.unconfiguredEnv.join(", ")} is not set`
        : result.withheld > 0 ? "withheld by the first-delivery guard"
        : "no approved copy to send";
      return { sent: 0, failed: result.failed, error: `${outlet.label} (${outlet.id}): ${reason}` };
    }
    return { sent: result.sent, failed: result.failed };
  } catch (err) {
    return { sent: 0, failed: 1, error: (err as Error).message };
  }
};

const deps: ApiDeps = {
  translationStore,
  saveTranslation,
  publishOne,
  storageMode,
  formattingStore,
  conversionStore,
  saveRendering: new SaveRendering(formattingStore, undefined, buildLineage()),
  approveRendering: new ApproveRendering(formattingStore, undefined, buildLineage()),
  loadStatus,
  loadPublishState,
  loadTranslations,
  xMaxWeighted: loadXMaxWeighted(),
  loadBoard,
  saveOutletOverride: new SaveOutletOverride(overrideStore),
  markDelivery: new MarkDelivery(deliveryLedger),
  sendToOutlet,
};

startServer(deps, { port, staticDir: join(REPO_ROOT, "web", "dist"), localPublishDir: paths.publishLocalDir });
console.log(`Review dashboard on http://localhost:${port}  (build the UI first: pnpm build:web)`);
