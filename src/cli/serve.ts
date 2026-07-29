import "./registerErrorHandler";
// src/cli/serve.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startServer } from "../adapters/web/HttpServer";
import type { ApiDeps } from "../adapters/web/apiHandlers";
import type { StatusView, PublishStateRow, IntegrationStatus } from "../adapters/web/apiHandlers";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { FileTranslationConfig } from "../adapters/store/FileTranslationConfig";
import { FileConversionConfig } from "../adapters/store/FileConversionConfig";
import { fewShotStoresByType } from "../adapters/store/JsonTypedFewShotStore";
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
import { PrepareConversions, type PendingVariant } from "../app/PrepareConversions";
import { PrepareConversionRun } from "../app/PrepareConversionRun";
import { FormatVariants } from "../app/FormatVariants";
import { archiveFile } from "../shared/store/archive";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
import { buildBoard, type BoardView } from "../adapters/web/board";
import { deliveredByChannelSender, outletById, outletsForChannel } from "../domain/outlet/models";
import { createSenders } from "./channelSenders";
import { buildRecorder } from "./recorder";
import { buildArchiver } from "./archiver";
import { quotaReader } from "./typefullyQuotaReader";
import { startReconcileScheduler } from "./reconcileScheduler";
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
  loadSheetLinks,
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
import { resolveSheetTitles } from "../adapters/sheets/sheetTitles";
import { deliveryKey } from "../domain/delivery/models";
import { ReconcilePublished } from "../app/ReconcilePublished";
import { JsonXArticleLedger } from "../adapters/store/JsonXArticleLedger";
import { TypefullyDraftLookup } from "../adapters/send/TypefullyDraftLookup";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";

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
    sheetLinks: await withSheetTitles(loadSheetLinks()),
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

/** Named after the workbooks themselves; falls back to the placeholder titles when unreachable. */
const withSheetTitles = resolveSheetTitles(() => createGoogleAuth(loadGoogleAuthConfig()));

const loadBoard = async (itemId: string): Promise<BoardView> => {
  const [renderings, overrides, deliveries, translations] = await Promise.all([
    formattingStore.loadAll(),
    overrideStore.loadAll(),
    deliveryLedger.loadAll(),
    translationStore.loadAll(),
  ]);
  return buildBoard(itemId, renderings, overrides, deliveries, translations.find((t) => t.itemId === itemId));
};

const isSendableChannel = (c: string): c is SendableChannel => c === "telegram" || c === "x";

/**
 * Ask Typefully whether the scheduled drafts have published, and write the real x.com urls back.
 *
 * The same pass `pnpm send:reconcile` runs. It has to be reachable from the board because that is
 * where the operator sees `예약됨` — telling them to open a terminal for the link to their own post
 * is how a row stays unresolved forever.
 */
const reconcilePublished = async (): Promise<{ reconciled: number; pending: number; error?: string }> => {
  let cfg;
  try {
    cfg = loadTypefullyConfig();
  } catch (err) {
    return { reconciled: 0, pending: 0, error: (err as Error).message };
  }
  try {
    return await new ReconcilePublished(
      deliveryLedger,
      new JsonXArticleLedger(paths.publishDir),
      new TypefullyDraftLookup(cfg.apiKey, cfg.socialSetId),
    ).run();
  } catch (err) {
    return { reconciled: 0, pending: 0, error: (err as Error).message };
  }
};

/**
 * The board's per-row [발송]: one item, one type, one room. `SendChannels` is the same use case the
 * CLI runs, narrowed on all three axes — the row the operator clicked must not also push the item's
 * other approved copy, or the same copy into the room next door.
 *
 * Every refusal comes back as `error` rather than as a throw: the dashboard has to name the reason,
 * and "the room has no chat id" is an install state, not a server fault. Naming the room explicitly
 * also lifts `SendChannels`' first-delivery guard, which is correct here — a human clicked it.
 */
/**
 * `resend` posts to a room the ledger already records as `sent`.
 *
 * The ledger is what makes a send happen at most once, so a re-send has to take that row out of the
 * way first — and put it back if the send then fails, or the room would read as never-delivered
 * while a real post sits in it. The original post is NOT removed from the room by any of this: two
 * messages exist afterwards, and the row that survives describes the second one.
 */
const sendToOutlet = async (itemId: string, type: string, outletId: string, resend = false): Promise<{ sent: number; failed: number; error?: string }> => {
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

  const key = deliveryKey({ itemId, type, outletId });
  const previous = resend ? (await deliveryLedger.loadAll()).find((e) => deliveryKey(e) === key) : undefined;
  if (resend) {
    if (!previous) return { sent: 0, failed: 0, error: `${outlet.label} (${outlet.id}): nothing has been sent to this room yet` };
    await deliveryLedger.remove(key);
  }

  try {
    const [record, archive] = await Promise.all([buildRecorder(), buildArchiver()]);
    const result = await new SendChannels(
      formattingStore,
      createSenders([channel]),
      deliveryLedger,
      // The board paints this row's lock from `sendBlock`; the same store makes this call enforce
      // it, so a row that looks sendable on screen is exactly a row that sends.
      translationStore,
      record,
      archive,
      undefined,
      loadXMaxWeighted(),
      outletsForChannel,
      chatIds,
      // Without this a forked room receives the *group* text — the wrong copy, irreversibly, since
      // the ledger then records the room as `sent` and a `sent` row can never be unmarked.
      overrideStore,
      quotaReader([channel]),
    ).run({ targets: [channel], ids: new Set([itemId]), types: [type], outletIds: [outletId] });

    // A quota refusal is not a plain zero-send: the operator needs to know the account is at its
    // ceiling, not that this row failed to send for some ordinary reason.
    if (result.quotaBlocked) {
      const { needed, available, resetsAt } = result.quotaBlocked;
      const when = resetsAt ? ` (${resetsAt.slice(0, 10)} 리셋)` : "";
      if (previous) await deliveryLedger.add(previous); // nothing went out — the room is still on its first post
      return { sent: 0, failed: 0, error: `Typefully 월간 발행 쿼터가 부족합니다 — 필요 ${needed}건, 잔여 ${available}건${when}` };
    }

    // `sent 0` on its own tells the reviewer nothing, so every zero-send outcome carries a reason.
    // Kept in the same English as the `MarkDelivery` / `SaveOutletOverride` refusals, which surface
    // through the same dashboard error path.
    if (result.sent === 0) {
      const reason =
        // Never "check the server log": a dashboard operator has no terminal open. `failures`
        // carries what the run actually hit (an over-limit segment, a sender's own error), which is
        // the difference between "edit the rendering" and "try again".
        result.failed > 0 ? result.failures.map((f) => f.error).join(" · ") || "the send failed"
        : result.skipped > 0 ? "already delivered to this room"
        : result.unconfigured > 0 ? `${result.unconfiguredEnv.join(", ")} is not set`
        : result.withheld > 0 ? "withheld by the first-delivery guard"
        : "no approved copy to send";
      if (previous) await deliveryLedger.add(previous); // nothing went out — the room is still on its first post
      return { sent: 0, failed: result.failed, error: `${outlet.label} (${outlet.id}): ${reason}` };
    }
    return { sent: result.sent, failed: result.failed };
  } catch (err) {
    if (previous) await deliveryLedger.add(previous); // the send threw before reaching the room
    return { sent: 0, failed: 1, error: (err as Error).message };
  }
};

// Same construction as `src/cli/convert-prepare.ts`, so the board and the CLI read and write the
// same worksheets and the same `output/variants/pending.json` batch.
const prepareConversions = new PrepareConversions(
  translationStore,
  new JsonGlossaryStore(paths.translationConfigDir),
  new FileTranslationConfig(paths.translationConfigDir),
  new FileConversionConfig(paths.conversionConfigDir),
  fewShotStoresByType(paths.conversionConfigDir),
  conversionStore,
);

/**
 * Persists the pending batch exactly like the CLI does — archive-then-overwrite, one batch live at
 * a time — and reports back the archived path. `archiveFile` is a `rename`: if the agent is midway
 * through filling a previous batch's worksheet, this move strands it (the ledger backing that
 * worksheet is gone). The CLI prints that as a warning in the operator's own terminal; the returned
 * path is how the same warning reaches a dashboard operator, who has no terminal to read.
 */
const savePendingVariants = async (pending: PendingVariant[]): Promise<string | undefined> => {
  const archived = await archiveFile(paths.variantsPending, paths.archiveDir, "pending-variants");
  if (archived) console.log(`  archived the previous unsaved batch → ${archived}`);
  await writeJsonFileAtomic(paths.variantsDir, paths.variantsPending, pending);
  return archived ?? undefined;
};

const prepareConversionRun = new PrepareConversionRun(
  prepareConversions,
  async (path, body) => {
    await mkdir(paths.variantsWorksheets, { recursive: true });
    await writeFile(path, body, "utf8");
  },
  paths.variantsWorksheets,
  undefined,
  savePendingVariants,
);

// Same stores and xMaxWeighted as `src/cli/format.ts` (non-refine branch), so a board-triggered
// reformat renders byte-identical output to `pnpm format`.
const formatVariants = new FormatVariants(conversionStore, formattingStore, undefined, loadXMaxWeighted());

const deps: ApiDeps = {
  translationStore,
  saveTranslation,
  publishOne,
  storageMode,
  formattingStore,
  conversionStore,
  saveRendering: new SaveRendering(formattingStore, undefined, buildLineage()),
  approveRendering: new ApproveRendering(formattingStore, conversionStore, fewShotStoresByType(paths.conversionConfigDir), undefined, buildLineage()),
  loadStatus,
  loadPublishState,
  loadTranslations,
  xMaxWeighted: loadXMaxWeighted(),
  loadBoard,
  saveOutletOverride: new SaveOutletOverride(overrideStore),
  markDelivery: new MarkDelivery(deliveryLedger),
  prepareConversionRun,
  formatVariants,
  sendToOutlet,
  reconcilePublished,
};

startServer(deps, { port, staticDir: join(REPO_ROOT, "web", "dist"), localPublishDir: paths.publishLocalDir });
console.log(`Review dashboard on http://localhost:${port}  (build the UI first: pnpm build:web)`);

// The board's [게시 확인] button stays — this only means an operator who never clicks it still
// sees real x.com links, a couple of minutes after the post goes out.
const stopReconcile = startReconcileScheduler(reconcilePublished, { log: (m) => console.log(m) });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { stopReconcile(); process.exit(0); });
