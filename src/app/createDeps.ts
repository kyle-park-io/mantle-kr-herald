// src/app/createDeps.ts
import { mkdir, writeFile } from "node:fs/promises";
import type { Db } from "../adapters/db/Db";
import type { ApiDeps, StatusView, PublishStateRow, IntegrationStatus } from "../adapters/web/apiHandlers";
import { createStores } from "../cli/stores";
import { PgAttemptLimiter, ipRowId } from "../adapters/store/PgAttemptLimiter";
import { PgTranslateFloorReport } from "../adapters/store/PgTranslateFloorReport";
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
import { funnelCounts } from "../status/pipeline";
import {
  collectedScope,
  translateFloorStatus,
  type TranslateFloorReport,
  type TranslateFloorStatus,
} from "../status/translateFloor";
import { xThreadIntake } from "../adapters/content/XContentSource";
import { realSystemdShow } from "../cli/systemdShow";
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
import { runLiveProbes, buildLiveProbeInput, type LiveProbeResult } from "../doctor/liveProbes";
import { PgCredentialLiveness } from "../adapters/store/PgCredentialLiveness";
import { summarizeLiveness, type LivenessObservation } from "../status/liveness";

/**
 * How long `probeLiveness` below waits for the credential observation to land before giving up on
 * it and answering anyway. The `pg` `Pool` behind `db` (`createDb.ts`, `vercel/entry.ts`,
 * `serve-hosted.ts`) sets neither `connectionTimeoutMillis` nor `query_timeout`, so a connection
 * that stalls rather than errors — pool exhaustion, a blackholed socket, Neon mid-restart — would
 * otherwise hang this call with nothing to bound it.
 *
 * The number is sized against what the write actually is, not guessed: one indexed single-row
 * `upsert`, the cheapest write Postgres does. The only extra latency a HEALTHY connection can add
 * on top of that is Neon waking a suspended compute — Neon's own docs put that at "a few hundred
 * milliseconds" — and this deployment's Vercel region (`sin1`) and Neon project region
 * (`ap-southeast-1`, `docs/ko/deploy.md`) are the same Singapore hop every other query already
 * makes, so there is no cross-region RTT to add on top. 2s is generous headroom over that combined
 * worst case. It is also well inside `runLiveProbes`' own 5s `DEFAULT_TIMEOUT_MS` (`liveProbes.ts`),
 * which exists for the identical reason (no `maxDuration` in `vercel.json`, so an unbounded hang
 * becomes a platform 504 indistinguishable from a deployment too old to have this route) — so a
 * stalled write cannot quietly turn that same promise into a lie for `probeLiveness` specifically.
 */
const LIVENESS_WRITE_TIMEOUT_MS = 2_000;

/**
 * Races `promise` against `ms`, rejecting with a plain, sayable message if the timer wins. Does not
 * — cannot — cancel `promise` itself: `Db.query` has no cancellation hook, so a write that loses
 * this race keeps running in the background and either lands late or fails on its own later, either
 * way harmlessly (the `.then` below still consumes its settlement, so a late rejection never
 * surfaces as an unhandled one). What this buys is bounding how long the CALLER waits — see
 * `LIVENESS_WRITE_TIMEOUT_MS` for why `probeLiveness` needs exactly that.
 *
 * A second copy of `withDeadline` in `src/doctor/liveProbes.ts` rather than an import of it: that
 * module's own header names its contract as two exports, `runLiveProbes` and `buildLiveProbeInput`,
 * and `withDeadline` — like the private `DeadlineError` it rejects with — is deliberately not one of
 * them. Importing it would mean widening that module's surface to reuse a five-line race, for a
 * caller that does not even want the same failure shape: `withDeadline` rejects with a `DeadlineError`
 * naming *what* timed out, where this rejects with a plain `Error` naming the millisecond bound —
 * the two are worded for different readers (a probe report vs. a `console.warn`), not accidentally
 * different.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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

  // Whether `POST /api/items/:id/convert-prepare` exists at all — same "computed once, used for
  // both" shape as `sendsEnabled` above, for the same reason. It gates the `prepareConversionRun`
  // construction below (which is what makes `handleApi` answer 404) AND `StatusView.conversionEnabled`,
  // so the board cannot offer a [변환 준비] button on a deployment whose route is not there. Without
  // the second half, the button's only disabled condition is "no type ticked": the operator picks
  // one, clicks, and reads the API's bare `not found`.
  const conversionEnabled = routes === "local";

  /**
   * The floor `translate:prepare` will actually select with — what qualifies the Collected total in
   * `loadStatus` below.
   *
   * Asked of systemd at most once per process, and on a hosted deployment not asked at all.
   * `routes === "hosted"` is a Vercel function: no systemd, no timer, no unit. Spawning `systemctl`
   * per `/api/status` there would cost a process to learn nothing, so the probe is skipped and the
   * floor reports the state it genuinely is in — `unreadable`. Deliberately NOT `none`: "the unit
   * sets no floor" and "this deployment cannot ask" are opposite facts (see `TranslateFloorKind`),
   * and reporting the first where the second is true would raise a false alarm on every hosted page
   * load.
   *
   * What the hosted deployment shows instead of nothing is `readFloorReport` below — the floor the
   * scheduler itself wrote down. This probe still takes precedence wherever it can answer; see
   * `collectedReach` in `translateFloor.ts` for the rule and why it is that way round.
   *
   * Memoised for `"local"` because `loadStatus` runs per request while `systemctl show` costs a
   * spawn, and the answer only changes on a `daemon-reload`. The always-fresh reader is `pnpm
   * status`, which asks once and exits.
   *
   * The invoking shell's own `HERALD_TRANSLATE_SINCE` is deliberately not passed: it is never the
   * floor (see `translateFloorStatus`), and the "your shell disagrees" warning it drives is a CLI
   * line with no home on this screen.
   */
  let translateFloor: TranslateFloorStatus | undefined;
  const readTranslateFloor = (): TranslateFloorStatus => {
    translateFloor ??= translateFloorStatus({
      unitShow: routes === "hosted" ? undefined : realSystemdShow(),
    });
    return translateFloor;
  };

  /**
   * The floor the *scheduler* last reported running with, out of the same Postgres this deployment
   * reads everything else from (`PgTranslateFloorReport`). This is what lets the hosted dashboard
   * say something true about the floor at all: the systemd probe above cannot run there, and the
   * value is deliberately not duplicated into a Vercel env var — one content decision with two homes
   * drifts silently, which is the hazard this whole area exists to remove.
   *
   * Read per request and never memoised, unlike the systemd probe. Its whole value is its freshness:
   * a card that shows how old the report is, over a value cached at process start, would age its own
   * answer by however long this function instance happens to live and report a scheduler as stale
   * that is running fine. One indexed single-row lookup beside the five the funnel already does.
   *
   * `undefined` when nothing has ever been reported (a database predating the scheduler's first
   * tick, or a local install with no scheduler at all), which reads as the same `unknown` the card
   * showed before this existed.
   */
  const floorReports = new PgTranslateFloorReport(db);

  /**
   * The read above, degraded to `undefined` rather than allowed to take `/api/status` down with it.
   *
   * This is not general nervousness about a query — it closes one specific, real window. The hosted
   * deployment is the only reader here that does NOT apply the schema at startup (`serve.ts` calls
   * `applySchema`; the Vercel entry point cannot), and the two deploys are separate events: Vercel
   * ships new code on merge, while `deploy/herald-deploy.sh` runs `pnpm db:migrate` when someone runs
   * it. So there is a stretch where a function instance holding this code talks to a Neon that has
   * no `translate_floor_reports` yet — and an uncaught `42P01` there does not degrade one hover card,
   * it 500s the whole status payload and the dashboard renders no header at all.
   *
   * Degrading is safe precisely because the fallback is honest: with no report the reach is
   * `unknown`, which is the exact state this screen showed before reports existed — "cannot be seen
   * from here", never a claim about the floor. And it is not how a missing table stays hidden:
   * `isSchemaApplied` checks every table in `TABLE_NAMES`, so `pnpm doctor` reports it, loudly, at
   * the layer whose job that is.
   */
  const readFloorReport = async (): Promise<TranslateFloorReport | undefined> => {
    try {
      return await floorReports.read();
    } catch (err) {
      console.warn(`[status] could not read the scheduler's translate floor report: ${(err as Error).message}`);
      return undefined;
    }
  };

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

  /**
   * Whether `local` is offered as a publish target at all — the third "computed once, used for both"
   * gate on this axis, after `sendsEnabled` and `conversionEnabled` above, and it is that shape for
   * the same reason: it feeds BOTH `StatusView.availableTargets` (the only thing that enables the
   * board's `[local] 발행` button — `TranslationDetail.tsx`) and `publishOne`'s own refusal below, so
   * the button and the route can never disagree about whether this deployment publishes to disk.
   *
   * Withheld on `hosted` because there is no disk there to publish to. The Vercel Function runs the
   * `dist/api-entry.js` bundle (`api/[...path].ts`), so `paths.ts`'s `REPO_ROOT` — resolved from the
   * running module's own location, deliberately not `process.cwd()` — is `/var/task`, and
   * `createUploaders` hands `local` a `LocalFileUploader(paths.publishLocalDir)` pointed at
   * `/var/task/output/publish/local/`, which is read-only. And nothing about that write was worth
   * saving even had it succeeded: `GET /api/publish/local/*`, the route that reads those files back,
   * is served by `HttpServer.ts` alone and sits deliberately outside `handleApi` (it needs the
   * filesystem and its own session gate), so the hosted entry point — which only ever calls
   * `handleApi` — has no route to serve one from, and the instance's filesystem leaves with the
   * instance regardless. Publishing to disk is not degraded on hosted; it is meaningless there.
   *
   * Not fixed in `resolveTargets` (`src/cli/uploaders.ts`), the other candidate layer. That function
   * takes a storage MODE, and the mode is not what is wrong here: `cloud` + `local` is a legitimate
   * combination the CLI relies on and `tests/cli/uploaders.test.ts` pins ("allows local alongside
   * cloud targets in cloud mode") — it is how `pnpm drive:publish --target both,local` keeps a
   * readable copy on the operator's own disk beside the Drive upload. What differs on hosted is WHERE
   * the process runs, which is the fact `routes` carries and a `--target` parser shared with the CLI
   * has no business learning; teaching it would mean a third argument threaded through every CLI
   * call site to express a property none of them vary on. `assertCloudStorage` (`src/vercel/entry.ts`)
   * is the same shape one level up and is why this is not caught there either: it fires once at
   * startup against the mode, and hosted's mode is `cloud` — the correct value — so a per-request
   * `target: "local"` never passes in front of it.
   *
   * `local` publishing on the local board is untouched by all of this: `pnpm serve` builds
   * `routes: "local"`, the target stays in `availableTargets`, the button stays live, and the write
   * lands in the repo's own `output/publish/local/` exactly as `src/cli/publish.ts` intends.
   */
  const localPublishEnabled = routes === "local";

  const usableTargets = ((): ("local" | "google" | "lark")[] => {
    const targets: ("local" | "google" | "lark")[] = localPublishEnabled ? ["local"] : [];
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

  /** Reads and (from `probeLiveness` below) writes the deployment's last credential observation —
   *  see that class's own doc comment for the one-writer rule. */
  const credentialLiveness = new PgCredentialLiveness(db);

  /**
   * Live credential checks — the counterpart to `integrations` above, which only reports presence.
   *
   * Both halves come from `src/doctor/liveProbes.ts`, including the environment-reading half. This
   * used to be a verbatim copy of `src/cli/doctor.ts`'s block, and a copy is exactly what that
   * module's header rules out: the drifted one would be this one, the one running in production.
   *
   * Records what it just observed before answering, which is what makes the daily `creds:check` and
   * every `deploy:smoke` populate the board's badge for free — no new command, no new unit, and no
   * second place that knows how to probe.
   *
   * The write is best-effort and deliberately cannot fail the call: this route's whole purpose is to
   * answer when things are broken. Bounded by `LIVENESS_WRITE_TIMEOUT_MS`, and not just against a
   * throw — the same reasoning `runLiveProbes`' own deadline rests on applies here too, see that
   * constant's comment.
   */
  const probeLiveness = async (): Promise<LiveProbeResult[]> => {
    const probes = await runLiveProbes(buildLiveProbeInput());
    try {
      await withTimeout(
        credentialLiveness.write({
          observedAt: new Date().toISOString(),
          probes: probes.map(({ key, status, detail }) => ({ key, status, detail })),
        }),
        LIVENESS_WRITE_TIMEOUT_MS,
      );
    } catch (err) {
      console.warn(`[diagnostics] could not record the credential observation: ${(err as Error).message}`);
    }
    return probes;
  };

  /** The read above, degraded to `undefined` rather than allowed to take `/api/status` down with it —
   *  the same window, and the same argument, as `readFloorReport`. */
  const readLiveness = async (): Promise<LivenessObservation | undefined> => {
    try {
      return await credentialLiveness.read();
    } catch (err) {
      console.warn(`[status] could not read the credential liveness observation: ${(err as Error).message}`);
      return undefined;
    }
  };

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
    // The rows behind the X half of the Collected total, read AFTER the items above and never
    // beside them: the Lark term is derived as `total - (threads - repliesDropped)`, so a `collect`
    // landing between the two reads must be able to make the thread count outrun the item count
    // (which reports no funnel at all) rather than the other way round, which would silently inflate
    // the Lark term. `pnpm status` reads them in this same order, for this same reason — hence one
    // sequential round trip here rather than a sixth entry in the `Promise.all` above.
    const threads = await stores.collectionRepository.loadAll();
    // Not in the `Promise.all` above either, but for a different reason than `threads`: these next
    // two are plain single-row reads, each with no ordering constraint of its own — not on `threads`,
    // and not on each other. They sit here, after `threads`, so the one pair above whose ORDER is
    // load-bearing stays visibly adjacent and nothing later mistakes either of these for part of that
    // pairing.
    const floorReport = await readFloorReport();
    const liveness = await readLiveness();
    const sync = syncSummary({ translations, entries, render: renderFor });
    return {
      storageMode,
      // `collected` is passed as items, not as a count: the scope's whole job is to say how many of
      // them sit at or after the scheduler's floor, which needs their `createdAt`. Same call the CLI
      // makes, so the header's hover card and `pnpm status`'s Collected line report one computation.
      funnel: funnelCounts(
        {
          collected: collected.length,
          translations,
          variants,
          renderings,
          published: entries,
        },
        collectedScope(collected, readTranslateFloor(), xThreadIntake(threads), floorReport),
      ),
      sync,
      availableTargets: usableTargets,
      integrations,
      sheetLinks: await withSheetTitles(loadSheetLinks()),
      dbEnv,
      sendsEnabled,
      conversionEnabled,
      // Hard-coded `false` rather than computed: constructing `CollectLinkedThread` behind its own
      // `TWITTERAPI_IO_KEY` guard is the next task on this branch (link-intake), not this one. This
      // keeps `StatusView` satisfied — and honest, since nothing here builds the dep yet — without
      // reaching ahead into work that task owns.
      intakeEnabled: false,
      liveness: liveness === undefined ? undefined : summarizeLiveness(liveness, sendsEnabled),
    };
  };

  const publishOne = async (itemId: string, target: string): Promise<PublishResult> => {
    const targets = resolveTargets(target, storageMode);
    // The other half of `localPublishEnabled` — see its own comment for why hosted has nowhere to
    // write. Withholding the target from `availableTargets` only disables a button; this refuses the
    // request, which is what a caller naming `local` directly still meets: a tab left open across the
    // deploy that added this, a replayed request, `curl`. Unlike `sendToOutlet`, the whole field
    // cannot be withheld to get this — publishing to Google/Lark is the hosted board's entire purpose
    // — so the withholding has to be per target, inside the closure, before `createUploaders` can
    // construct a `LocalFileUploader`.
    //
    // Throws rather than returning a `PublishResult`, because a result is exactly how this failure
    // used to hide: `PublishTranslations` catches each uploader's error INTO `result.failures` and
    // the route answers 200, so the EROFS write already came back as a 200 carrying
    // `{ uploaded: 0, failed: 1 }` — a shape the board renders as an ordinary publish attempt that
    // did not take. A throw reaches the entry points' own catch (`HttpServer.ts`, `vercel/entry.ts`),
    // both of which hand a signed-in operator the message verbatim in a 500.
    if (!localPublishEnabled && targets.includes("local")) {
      throw new Error(
        'publish target "local" is not available on the hosted deployment: it would write approved ' +
          `documents to this function's read-only filesystem (${paths.publishLocalDir}), and no hosted ` +
          "route serves them back. Publish to google or lark, or run this from the local board.",
      );
    }
    return new PublishTranslations(translationStore, await createUploaders(targets), publishStore).run({ itemId });
  };

  const loadTranslations = async () =>
    attachKind(await translationStore.loadAll(), await contentSource.loadPending(new Set()));

  /**
   * 되돌리기's write path. Reuses `SaveTranslation.run` (`approve: false`) rather than a narrow store
   * method, because that class already preserves `postedUrl`/`postedAt`/`publishedText` across an
   * ordinary save — it reads the existing row before it writes, specifically so a save landing on an
   * item reconcile just retired does not silently drop the evidence (see `SaveTranslation.run`'s own
   * comment). Reusing it here means the one preservation rule lives in one place rather than being
   * re-implemented for the dashboard's own write path.
   *
   * A no-op — never a throw — when the item has already vanished: the route above already 404s
   * before ever calling this, so the only way to reach this branch is a race between two requests for
   * the same id, which is not this function's job to referee (see `RetireTranslation`'s own doc
   * comment on the residual save/retire race this whole area inherits).
   */
  const unretireTranslation = async (itemId: string): Promise<void> => {
    const existing = (await translationStore.loadAll()).find((t) => t.itemId === itemId);
    if (!existing) return;
    await saveTranslation.run({
      itemId: existing.itemId,
      source: existing.source,
      sourceText: existing.sourceText,
      koreanText: existing.koreanText,
      approve: false,
      isReply: existing.isReply,
      refUrl: existing.refUrl,
    });
  };

  /**
   * 게시됨으로 — the withdrawal of a 되돌리기 dispute, and the reason `unretireTranslation` above is no
   * longer a one-way door.
   *
   * Written as a bare `upsert` rather than through `RetireTranslation` on purpose: that class is
   * idempotent *on `postedUrl` already being set* — it returns `already-retired` without touching
   * the status — precisely so an unattended reconcile pass can never re-apply a match a human just
   * disputed. Every item reaching this function has `postedUrl` set (the route checks first), so
   * routing it through that class would be a guaranteed no-op.
   *
   * Spreads `existing`, so an edit the reviewer made after the dispute survives — Kyle's call. The
   * copy that actually went out is still on the row as `publishedText`, and 1차 검수 diffs the two,
   * so a divergence is displayed rather than silently asserted away.
   */
  const retireTranslation = async (itemId: string): Promise<void> => {
    const existing = (await translationStore.loadAll()).find((t) => t.itemId === itemId);
    if (!existing) return;
    await translationStore.upsert({ ...existing, status: "posted" });
  };

  const loadPublishState = async (): Promise<PublishStateRow[]> => {
    const [entries, translations] = await Promise.all([publishStore.listEntries(), translationStore.loadAll()]);
    const byId = new Map(translations.map((t) => [t.itemId, t] as const));
    return entries.map((e) => {
      // A row is synced when it matches the item's CURRENT status and current render; a status change
      // (review doc after approval) or an edit since upload flips it to "needs republish".
      //
      // Except for a `posted` item, which is terminal for the Drive path (`PublishTranslations` skips
      // it, `syncSummary` does not count it, and both the 발행 buttons and the publish route refuse
      // it). Its doc is the correct record of the copy that went out, so the row is reported as
      // synced rather than as "재발행 필요" — a status the reviewer could no longer act on even if it
      // were true, and which before this fix invited them to press 발행 and thereby upload the item
      // to review/ and delete its approved doc. This is the same rule `syncSummary` applies to the
      // account-wide counts, applied per row; the two must agree or the banner and the detail pane
      // disagree about the same item.
      const t = byId.get(e.itemId);
      const synced = t ? t.status === "posted" || (e.status === t.status && !isStale(e, contentHash(renderFor(t)))) : undefined;
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
  if (conversionEnabled) {
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
  // reformat renders byte-identical output to `pnpm format` — `translationStore` included, which is
  // what makes the `posted` gate hold for the route as well as for the CLI. Handing this one a
  // narrower set of stores than the CLI gets is how the two would come to disagree about which
  // items are finished.
  const formatVariants = new FormatVariants(conversionStore, formattingStore, translationStore, undefined, loadXMaxWeighted());

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
    unretireTranslation,
    retireTranslation,
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
    // `collectLinkedThread` is left unset — its optionality on `ApiDeps` is exactly the "absent means
    // not built yet" shape `sendToOutlet`/`prepareConversionRun` already use, and constructing the
    // real one is the next task on this branch. `loadIntakePending` has no such optionality (a
    // deployment with no X credential still reads the queue), so it needs a body now; an empty list
    // is honest today, since nothing here writes to the collection repository through this door yet.
    loadIntakePending: async () => [],
    formatVariants,
    // Absent (not a function that would just refuse every call) when sends are closed — see
    // `ApiDeps.sendToOutlet`'s own doc comment (`apiHandlers.ts`) for why this mirrors
    // `prepareConversionRun` just above.
    sendToOutlet: sendsEnabled ? sendToOutlet : undefined,
    reconcilePublished,
    loadQuota,
    probeLiveness,
  };
}
