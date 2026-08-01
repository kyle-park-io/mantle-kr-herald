// src/app/createDeps.ts
import { mkdir, writeFile } from "node:fs/promises";
import type { Db } from "../adapters/db/Db";
import type { ApiDeps, StatusView, PublishStateRow, IntegrationStatus } from "../adapters/web/apiHandlers";
import { createStores } from "../cli/stores";
import { PgAttemptLimiter, ipRowId } from "../adapters/store/PgAttemptLimiter";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { FileTranslationConfig } from "../adapters/store/FileTranslationConfig";
import { FileConversionConfig } from "../adapters/store/FileConversionConfig";
import { SaveTranslation } from "./SaveTranslation";
import { PublishTranslations, type PublishResult } from "./PublishTranslations";
import { SaveRendering } from "./SaveRendering";
import { ApproveRendering } from "./ApproveRendering";
import { SaveOutletOverride } from "./SaveOutletOverride";
import { MarkDelivery } from "./MarkDelivery";
import { PrepareConversions, type PendingVariant } from "./PrepareConversions";
import { PrepareConversionRun } from "./PrepareConversionRun";
import { FormatVariants } from "./FormatVariants";
import { archiveFile } from "../shared/store/archive";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
import { buildBoard, type BoardView } from "../adapters/web/board";
import { makeLoadHeadroom } from "../cli/publishHeadroom";
import { makeSendToOutlet } from "../cli/sendToOutlet";
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
  loadDbEnv,
  loadAuthConfig,
  loadSessionConfig,
  loadClientIpConfig,
  loadSendsEnabled,
} from "../config";
import { Login, type LoginResult } from "./Login";
import { singleFlight } from "../shared/concurrency/singleFlight";
import { createUploaders, resolveTargets } from "../cli/uploaders";
import { paths } from "../paths";
import { syncSummary } from "../status/sync";
import { renderApproved, renderReview } from "../domain/publish/renderers";
import { contentHash, isStale } from "../domain/publish/syncLedger";
import type { Translation } from "../domain/translation/models";
import { publishRowLinks, type PublishLinkConfig } from "../adapters/web/publishLinks";
import { attachKind } from "../adapters/web/attachKind";
import { resolveSheetTitles } from "../adapters/sheets/sheetTitles";
import { ReconcilePublished } from "./ReconcilePublished";
import { TypefullyDraftLookup } from "../adapters/send/TypefullyDraftLookup";
import type { DraftLookup } from "../ports/DraftLookup";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";

/** Which route set an entry point serves. See `prepareConversionRun`'s construction below — this is
 *  the one axis the route set currently varies on. */
export type RouteSet = "local" | "hosted";

export interface CreateDepsInput {
  /** Already open — one pool per process (`serve.ts`) or one per function instance (the Vercel
   *  entry point, Plan C Task 2), never one per call to this function. */
  db: Db;
  routes: RouteSet;
}

/**
 * Builds the full dependency graph `handleApi` (`apiHandlers.ts`) runs against, given an already-open
 * `db` and which route set to serve.
 *
 * This used to be `serve.ts`'s own module-level construction — singletons built as the file was
 * imported, which is exactly what a long-lived local server wants and a per-request Vercel function
 * cannot do. Pulling it out into a plain function is what lets both entry points share one
 * construction site: `serve.ts` calls this once at process start, the hosted entry point calls it
 * once per function instance (over a pool from `attachDatabasePool`).
 *
 * `routes` is the one thing that varies the shape of what comes back: `prepareConversionRun` is
 * built (and returned) only for `"local"`. See its own comment below for why, and
 * `apiHandlers.ts`'s `ApiDeps.prepareConversionRun` doc comment for how `handleApi` turns its
 * absence into a 404 rather than a hidden button. Every other field is identical between the two
 * route sets — the hosted deployment reads and writes the same stores, through the same use cases,
 * over the one `db` it was handed.
 */
export function createDeps(input: CreateDepsInput): ApiDeps {
  const { db, routes } = input;

  // The database's own stated environment label, for the dashboard's non-production banner
  // (`StatusView.dbEnv` below) — `loadDbEnv()` rather than `loadDbConfig()` because this function
  // never needs a `DATABASE_URL`: `db` arrives already open, built by whichever caller constructed
  // it (a real Postgres pool for `serve.ts`, `attachDatabasePool` for the hosted entry point, PGlite
  // for a test's `createTestDb()`).
  const dbEnv = loadDbEnv();

  // Whether `POST /api/outlets/:id/:type/:outletId/send` is actually reachable — the local entry
  // point always sends (unaffected by `HERALD_SENDS_ENABLED`, exactly as it always has); the hosted
  // one ships closed until the flag is turned on. Computed once, here, and used for BOTH the
  // `ApiDeps.sendToOutlet` field below and `StatusView.sendsEnabled` in `loadStatus`, so the route's
  // own refusal and the board's banner can never disagree about which state this deployment is in.
  const sendsEnabled = routes === "local" || loadSendsEnabled();

  // Refuses to build a dependency set without a secret to sign/verify sessions with — see
  // `loadSessionConfig()`'s own doc comment for why this is a hard refusal, not an optional one.
  const sessionConfig = loadSessionConfig();

  // Off unless a deployment turns it on — see `loadClientIpConfig()`'s own doc comment for why trusting
  // `X-Forwarded-For` is never inferred, and `clientIp.ts`'s `resolveClientIp` for what a caller gets
  // back in either mode.
  const ipConfig = loadClientIpConfig();

  // Refuses to build a dependency set without an account configured — see `loadAuthConfig()`'s own
  // doc comment for why this is required now, unlike the `tryLoadAuthConfig()` this used to call.
  const authConfig = loadAuthConfig();

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
      dbEnv,
      sendsEnabled,
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
   * dependency graph down over a guard it has no use for — including every Telegram resend, which needs
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

  /**
   * Writes a conversion worksheet for the local agent to fill in — built only for `routes === "local"`.
   * The hosted deployment has no local agent on the other end of a worksheet path, so it never
   * constructs `PrepareConversions`/`PrepareConversionRun` at all rather than building one nobody can
   * use; `ApiDeps.prepareConversionRun` stays `undefined`, and `handleApi` turns that into a 404 for
   * `POST /api/items/:id/convert-prepare` — the route does not exist, not merely "does nothing".
   */
  let prepareConversionRun: PrepareConversionRun | undefined;
  if (routes === "local") {
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

    prepareConversionRun = new PrepareConversionRun(
      prepareConversions,
      async (path, body) => {
        await mkdir(paths.variantsWorksheets, { recursive: true });
        await writeFile(path, body, "utf8");
      },
      paths.variantsWorksheets,
      undefined,
      savePendingVariants,
    );
  }

  // Same stores and xMaxWeighted as `src/cli/format.ts` (non-refine branch), so a board-triggered
  // reformat renders byte-identical output to `pnpm format`.
  const formatVariants = new FormatVariants(conversionStore, formattingStore, undefined, loadXMaxWeighted());

  /** Shared by both lockout layers below — see `attemptLimiter.ts`'s doc comment for why there are two. */
  const LOGIN_LOCKOUT_MS = 60_000;

  /** Today's original threshold, unchanged — what stops a single address from locking out everyone else. */
  const PER_IP_LOGIN_MAX_FAILURES = 5;

  /**
   * 10x the per-IP threshold. A backstop has to sit clearly above anything ordinary team noise could
   * produce — several people mistyping the one shared password around the same time is, worst case, a
   * handful of failures, nowhere near 50 — while still being low enough that a genuinely distributed
   * attempt (many addresses, each staying under its own per-IP limit of 5 to avoid tripping that layer)
   * still trips something before it could ever reach `singleFlight`'s own natural ceiling: at most one
   * scrypt derivation in flight for the whole process, ~100–300ms each, so 50 failures is already a
   * meaningful fraction of a minute's entire possible throughput, not a number an attacker reaches for
   * free. `docs/ko/team-runbook.md`'s locked-out-login entry has the escape hatch for whichever counter
   * is holding the lock — the one that actually matters for the whole team is this one.
   */
  const GLOBAL_LOGIN_MAX_FAILURES = 50;

  /**
   * Backed by `auth_attempts` (`PgAttemptLimiter`), not memory, over the same `db` the stores use — so
   * failed attempts accumulate across restarts, and across the several instances a real deployment can
   * run at once, instead of each process getting its own fresh five-attempt allowance. `authConfig` is
   * checked non-optional above; by the time this line runs, refusing to build over a missing account
   * has already happened. The global backstop, one of the two layers `Login.run` now consults — the
   * per-IP layer is built fresh per request, just below, since its row key depends on that request's
   * address.
   */
  const loginUseCase = new Login(authConfig, new PgAttemptLimiter(db, { maxFailures: GLOBAL_LOGIN_MAX_FAILURES, lockoutMs: LOGIN_LOCKOUT_MS }));

  /**
   * The per-IP layer for one request, or `undefined` when `clientIp.ts`'s `resolveClientIp` could not
   * trust an address for it — `Login.run` already treats `undefined` as "only the global layer votes",
   * so this never has to invent a fallback key. A fresh `PgAttemptLimiter` per call, not a cached map
   * keyed by address: the class itself is a thin wrapper over `db` plus an id, cheap to construct, and
   * a cache would itself be an unbounded structure keyed by attacker-influenced values — precisely what
   * `PgAttemptLimiter.recordFailure`'s own eviction sweep exists to avoid doing to the DATABASE; doing
   * it again in process memory would just move the same problem.
   */
  function ipLoginLimiter(clientIp: string | undefined): PgAttemptLimiter | undefined {
    return clientIp ? new PgAttemptLimiter(db, { id: ipRowId(clientIp), maxFailures: PER_IP_LOGIN_MAX_FAILURES, lockoutMs: LOGIN_LOCKOUT_MS }) : undefined;
  }

  /** How long a caller who hit the single-flight guard below is told to wait — see its own comment. */
  const LOGIN_BUSY_RETRY_MS = 1000;

  /**
   * `POST /api/login` is the one route the session gate leaves open to unauthenticated callers, so it
   * cannot be protected by requiring what it exists to grant. `Login.run`'s lockout only throttles
   * SEQUENTIAL guesses — several concurrent requests all read "not locked out" before any of them has
   * recorded a failure, so they would all reach `verifyPassword`'s scrypt derivation (~64MB, 100–300ms
   * each) at once. `singleFlight` (`src/shared/concurrency/singleFlight.ts`) caps that at one
   * derivation in flight for the whole process; a concurrent second attempt is refused the same way a
   * lockout is (`{ ok: false, retryAfterMs }`), not queued.
   */
  const login = singleFlight(
    (credentials: { username: string; password: string }, clientIp: string | undefined) =>
      loginUseCase.run(credentials, new Date(), ipLoginLimiter(clientIp)),
    (): LoginResult => ({ ok: false, retryAfterMs: LOGIN_BUSY_RETRY_MS }),
  );

  return {
    translationStore,
    saveTranslation,
    publishOne,
    login,
    sessionConfig,
    ipConfig,
    // Overwritten per request by `HttpServer` from the incoming `Cookie` header (`session`) or socket
    // /`X-Forwarded-For` (`clientIp`) — these base values are never read.
    session: undefined,
    clientIp: undefined,
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
    // Absent (not a function that would just refuse every call) when sends are closed — see
    // `ApiDeps.sendToOutlet`'s own doc comment (`apiHandlers.ts`) for why this mirrors
    // `prepareConversionRun` just above.
    sendToOutlet: sendsEnabled ? sendToOutlet : undefined,
    reconcilePublished,
    loadQuota,
  };
}
