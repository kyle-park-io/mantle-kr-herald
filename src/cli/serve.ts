import "./registerErrorHandler";
// src/cli/serve.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startServer } from "../adapters/web/HttpServer";
import type { ApiDeps } from "../adapters/web/apiHandlers";
import type { StatusView, PublishStateRow, IntegrationStatus } from "../adapters/web/apiHandlers";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { FileTranslationConfig } from "../adapters/store/FileTranslationConfig";
import { FileConversionConfig } from "../adapters/store/FileConversionConfig";
import { SaveTranslation } from "../app/SaveTranslation";
import { PublishTranslations } from "../app/PublishTranslations";
import { SaveRendering } from "../app/SaveRendering";
import { ApproveRendering } from "../app/ApproveRendering";
import { SaveOutletOverride } from "../app/SaveOutletOverride";
import { MarkDelivery } from "../app/MarkDelivery";
import { PrepareConversions, type PendingVariant } from "../app/PrepareConversions";
import { PrepareConversionRun } from "../app/PrepareConversionRun";
import { FormatVariants } from "../app/FormatVariants";
import { archiveFile } from "../shared/store/archive";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
import { buildBoard, type BoardView } from "../adapters/web/board";
import { startReconcileScheduler } from "./reconcileScheduler";
import { makeLoadHeadroom } from "./publishHeadroom";
import { makeSendToOutlet } from "./sendToOutlet";
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
  loadDbConfig,
} from "../config";
import { createUploaders, resolveTargets } from "./uploaders";
import type { PublishResult } from "../app/PublishTranslations";
import { REPO_ROOT, paths } from "../paths";
import { syncSummary } from "../status/sync";
import { renderApproved, renderReview } from "../domain/publish/renderers";
import { contentHash, isStale } from "../domain/publish/syncLedger";
import type { Translation } from "../domain/translation/models";
import { publishRowLinks, type PublishLinkConfig } from "../adapters/web/publishLinks";
import { attachKind } from "../adapters/web/attachKind";
import { resolveSheetTitles } from "../adapters/sheets/sheetTitles";
import { ReconcilePublished } from "../app/ReconcilePublished";
import { TypefullyDraftLookup } from "../adapters/send/TypefullyDraftLookup";
import type { DraftLookup } from "../ports/DraftLookup";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";

const port = Number(process.env.PORT) || 5757;
// One pool for the life of this process — a long-running server, unlike the one-shot CLI commands,
// which each open and close their own.
const db = createDb(loadDbConfig());
const stores = createStores(db);
const translationStore = stores.translationStore;
const publishStore = stores.publishStore;
const saveTranslation = new SaveTranslation(translationStore, stores.fewShotStore, undefined, stores.lineageStore);
const formattingStore = stores.formattingStore;
const conversionStore = stores.conversionStore;
// Same database the CLI uses, so `send:channels` and the dashboard read one ledger, not two.
const overrideStore = stores.overrideStore;
const deliveryLedger = stores.deliveryLedger;
const xArticleLedger = stores.xArticleLedger;

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

const contentSource = stores.contentSource;

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

// The board's banner: the account-wide Typefully publishing quota plus the in-flight count that
// turns it into the number the send gate actually enforces. See publishHeadroom.ts for the caching
// and staleness rules — extracted so both are unit-tested rather than living in this closure, and so
// the gate and the banner read the exact same arithmetic.
const loadQuota = makeLoadHeadroom(deliveryLedger, xArticleLedger);

/**
 * Ask Typefully whether the scheduled drafts have published, and write the real x.com urls back.
 *
 * The same pass `pnpm send:reconcile` runs. It has to be reachable from the board because that is
 * where the operator sees `예약됨` — telling them to open a terminal for the link to their own post
 * is how a row stays unresolved forever.
 */
const reconcilePublished = async (): Promise<{ reconciled: number; retired: number; pending: number; error?: string }> => {
  let cfg;
  try {
    cfg = loadTypefullyConfig();
  } catch (err) {
    return { reconciled: 0, retired: 0, pending: 0, error: (err as Error).message };
  }
  try {
    return await new ReconcilePublished(
      deliveryLedger,
      xArticleLedger,
      new TypefullyDraftLookup(cfg.apiKey, cfg.socialSetId),
    ).run();
  } catch (err) {
    return { reconciled: 0, retired: 0, pending: 0, error: (err as Error).message };
  }
};

/**
 * The window the resend guard looks through before it re-posts to an X room — see
 * `guardQueuedDraft` in sendToOutlet.ts for what it does with the answer.
 *
 * Constructed here in its own try/catch, the way `headroomReader` guards its own construction: a
 * Telegram-only install has no `TYPEFULLY_*` env, and a throw on this line would take the whole
 * dashboard down over a guard it has no use for — including every Telegram resend, which needs
 * nothing from Typefully at all. `undefined` skips the guard, which is safe precisely here: the same
 * missing credentials stop `createSenders` from building an X sender, so there is no X post to
 * duplicate.
 */
let draftLookup: DraftLookup | undefined;
try {
  const typefully = loadTypefullyConfig();
  draftLookup = new TypefullyDraftLookup(typefully.apiKey, typefully.socialSetId);
} catch {
  // Typefully not configured — nothing was ever scheduled through it, so no resend can race a draft.
}

// The board's per-row [발송] and its resend restore — see sendToOutlet.ts for both doc comments,
// carried there verbatim. `articleLedger` here is the same singleton `reconcilePublished` reads
// from, not a fresh instance, so headroom reads never disagree with it — `xArticleLedger` is
// constructed once above (from `stores`) and shared by both.
const sendToOutlet = makeSendToOutlet({ formattingStore, deliveryLedger, translationStore, overrideStore, articleLedger: xArticleLedger, draftLookup });

// Same construction as `src/cli/convert-prepare.ts`, so the board and the CLI read and write the
// same worksheets and the same `output/variants/pending.json` batch.
const prepareConversions = new PrepareConversions(
  translationStore,
  new JsonGlossaryStore(paths.translationConfigDir),
  new FileTranslationConfig(paths.translationConfigDir),
  new FileConversionConfig(paths.conversionConfigDir),
  stores.fewShotStoresByType,
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
  saveRendering: new SaveRendering(formattingStore, undefined, stores.lineageStore),
  approveRendering: new ApproveRendering(formattingStore, conversionStore, stores.fewShotStoresByType, undefined, stores.lineageStore),
  loadStatus,
  loadPublishState,
  loadTranslations,
  xMaxWeighted: loadXMaxWeighted(),
  loadBoard,
  // The dashboard is the only writer of overrides, so this is the only place a fork's text can be
  // captured — and `그룹 글로 되돌리기` is the only click in the pipeline that deletes an unrecoverable text.
  saveOutletOverride: new SaveOutletOverride(overrideStore, undefined, stores.lineageStore),
  markDelivery: new MarkDelivery(deliveryLedger),
  prepareConversionRun,
  formatVariants,
  sendToOutlet,
  reconcilePublished,
  loadQuota,
};

startServer(deps, { port, staticDir: join(REPO_ROOT, "web", "dist"), localPublishDir: paths.publishLocalDir });
console.log(`Review dashboard on http://localhost:${port}  (build the UI first: pnpm build:web)`);

// The board's [게시 확인] button stays — this only means an operator who never clicks it still
// sees real x.com links, a couple of minutes after the post goes out.
//
// Guarded: a Telegram-only install has no TYPEFULLY_* env. Every other Typefully-optional path on
// this branch treats that as "nothing to do" (headroomReader returns undefined, doctor uses
// optionalCheck) — without this guard, `reconcilePublished` would report the missing-key error as
// `r.error` on every tick, forever, on an install that is not broken.
try {
  loadTypefullyConfig();
  startReconcileScheduler(reconcilePublished, { log: (m) => console.log(m) });
} catch {
  // Typefully not configured — nothing was ever scheduled through it, so there is nothing to reconcile.
}
