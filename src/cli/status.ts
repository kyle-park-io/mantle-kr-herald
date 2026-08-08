import "./registerErrorHandler";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig, describeDbTarget } from "../config";
import { createStores } from "./stores";
import { pipelineStages, formatStatus } from "../status/pipeline";
import { renderApproved, renderReview } from "../domain/publish/renderers";
import { syncSummary, formatSyncSummary } from "../status/sync";
import { translateFloorStatus, collectedScope } from "../status/translateFloor";
import { xThreadIntake } from "../adapters/content/XContentSource";
import { realSystemdShow } from "./systemdShow";
import { PgTranslateFloorReport } from "../adapters/store/PgTranslateFloorReport";

const cfg = loadDbConfig();
console.log(`database: ${cfg.env} · ${describeDbTarget(cfg)}`);

const db = createDb(cfg);
try {
  const stores = createStores(db);

  // The items, not just their count: the Collected total means very little on its own, and the one
  // thing that qualifies it — how many of them sit at or after the scheduler's translation floor —
  // needs their `createdAt`. `collectedScope` and the stage total therefore come from this one
  // array, so the note can never describe a different set than the number it sits beside.
  const collected = await stores.contentSource.loadPending(new Set());
  // The rows behind the X half of that total, read here because by the time an item exists the
  // dropped threads are gone: ~41% of everything ever collected is a reply Mantle made to someone
  // else, filtered out before any item is built (`isCommenterReply`). Without this the total
  // answered "is 134 even right?" with a database query, which is the signal it belonged on screen.
  //
  // Two reads of the same database, back to back and deliberately in this order: a `collect` landing
  // between them can only make the thread count outrun the item count, which `intakeTerms` reports
  // by printing no funnel at all. The other order would silently inflate the Lark term instead.
  const threads = await stores.collectionRepository.loadAll();
  const translations = await stores.translationStore.loadAll();
  const variants = await stores.conversionStore.loadAll();
  const renderings = await stores.formattingStore.loadAll();
  const entries = await stores.publishStore.listEntries();

  // Asked of systemd, never of `process.env`: `HERALD_TRANSLATE_SINCE` is unset in a hand-run of
  // this command, and a shell that happens to export it is still not what the timer fires with.
  // Trusting either is the mistake this line exists to stop — on 2026-08-08 the 108 items this
  // table reported were passed on to a human as a backlog, when the unit's floor put the whole
  // 2026-06-01 ~ 07-22 stretch of them permanently out of the scheduler's reach.
  const floor = translateFloorStatus({ unitShow: realSystemdShow(), shellValue: process.env.HERALD_TRANSLATE_SINCE });

  // What the scheduler last wrote down about the floor it ran with. On the machine that owns the
  // unit this is almost always the same answer `realSystemdShow()` just gave — and that is the
  // point: when it is NOT, `collectedReach` prints the gap, which means either the unit was edited
  // and no tick has run since, or the scheduler has stopped running. Both are things this command's
  // reader wants to know and neither is visible from the systemd probe alone.
  const floorReport = await new PgTranslateFloorReport(db).read();

  // "Published (drive)" counts ledger rows — one per (itemId, status, target) upload — and names
  // the items behind them, because one item published to google and lark is two rows.
  console.log(
    formatStatus(
      pipelineStages(
        { collected: collected.length, translations, variants, renderings, published: entries },
        collectedScope(collected, floor, xThreadIntake(threads), floorReport),
      ),
      floor,
    ),
  );
  // The sync line's "N published" counts unique translations with at least one ledger row.
  // These two numbers will diverge once multiple upload targets are enabled (e.g. Google and Lark).
  console.log(
    formatSyncSummary(
      syncSummary({
        translations,
        entries,
        render: (t) => (t.status === "approved" ? renderApproved(t) : renderReview(t)),
      }),
    ),
  );
} finally {
  await db.close();
}
