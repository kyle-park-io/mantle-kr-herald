import "./registerErrorHandler";
import { argValue, parseList } from "./args";
import { loadTelegramChatIds, loadXMaxWeighted, loadDbConfig } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { assertLedgerMigrated } from "./assertLedgerMigrated";
import { OUTPUT_DIR } from "../paths";
import { ALL_OUTLETS, deliveredByChannelSender, outletById, outletsForChannel } from "../domain/outlet/models";
import { SendChannels } from "../app/SendChannels";
import { resolveChannelTargets, createSenders } from "./channelSenders";
import { buildRecorder } from "./recorder";
import { buildArchiver } from "./archiver";
import { headroomReader } from "./publishHeadroom";

/** Usage/error text is interpolated from ALL_OUTLETS: a hardcoded list goes stale invisibly. */
const OUTLETS_USAGE = ALL_OUTLETS.map((o) => o.id).join("|");

const targets = resolveChannelTargets(argValue("--target"));
const outletIds = parseList(argValue("--outlets"));
const unknownOutlets = (outletIds ?? []).filter((id) => !outletById(id));
// Validated before the senders are built, so a typo fails on the flag rather than on missing env.
if (unknownOutlets.length > 0) {
  throw new Error(`Unknown outlet: ${unknownOutlets.join(", ")}. Usage: pnpm send:channels [--outlets <${OUTLETS_USAGE}>]`);
}
// A real id this CLI never delivers (a manual room, or x-article) would otherwise just report
// "sent 0" with no reason given.
const notSendable = (outletIds ?? []).filter((id) => {
  const o = outletById(id);
  return o !== undefined && !deliveredByChannelSender(o);
});
if (notSendable.length > 0) {
  console.warn(`[send] ${notSendable.join(", ")}: not delivered by send:channels (a manual room, or a room with its own pipeline) — ignored.`);
}

const pin = process.argv.includes("--pin");
// Forwarded unchanged to SendChannels — see SendChannelsInput.pin for why this is not gated per
// channel there. Warned here instead, once, since a `--pin` run with no telegram target would
// otherwise silently do nothing.
if (pin && !targets.includes("telegram")) {
  console.warn("[send] --pin has no effect: nothing can be pinned on a channel other than telegram.");
}

const senders = createSenders(targets);
const idsArg = argValue("--ids");
const ids = idsArg ? new Set(idsArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) : undefined;

const db = createDb(loadDbConfig());
try {
  // Refuses to send when the deliveries table looks unmigrated — see assertLedgerMigrated's own
  // doc comment. Checked before anything else in this block: a resend guard downstream of an empty
  // ledger read cannot catch this itself.
  await assertLedgerMigrated(db, OUTPUT_DIR);
  const stores = createStores(db);
  const store = stores.formattingStore;
  const ledger = stores.deliveryLedger;
  const articleLedger = stores.xArticleLedger;
  // The CLI has to honour forks too: a room that received its own copy from the dashboard must not
  // receive the group copy from here, or the two disagree about what that room was sent.
  const overrides = stores.overrideStore;
  // Each room's approval is checked against the approval of the translation it came from, so copy
  // whose source was withdrawn — or rewritten and re-approved since — stays put instead of going live.
  const translations = stores.translationStore;
  const record = await buildRecorder();
  const archive = await buildArchiver();

  const result = await new SendChannels(
    store,
    senders,
    ledger,
    translations,
    record,
    archive,
    undefined,
    loadXMaxWeighted(),
    outletsForChannel,
    loadTelegramChatIds(),
    overrides,
    headroomReader(targets, ledger, articleLedger),
  ).run({ targets, ids, outletIds, pin });
  // The extra segments appear only when they happened, so an ordinary run prints the line it always
  // printed. Both are kept out of `failed`: neither is a send that went wrong.
  const parts = [`sent ${result.sent}`, `skipped ${result.skipped} (already sent)`, `failed ${result.failed}`];
  if (result.unconfigured > 0) parts.push(`미설정 ${result.unconfigured} (${result.unconfiguredEnv.join(", ")})`);
  if (result.withheld > 0) parts.push(`보류 ${result.withheld} (첫 발송 — --outlets 로 방을 지정하세요)`);
  console.log(parts.join(" · "));
  // Each warning names the room it happened to, so a batch that pinned nine of ten rooms names the
  // tenth instead of leaving the operator to guess from the summary counts alone. Worded
  // differently from SendChannels' own `[send] <key>: …` line (printed as each send happens) so
  // this recap after the summary reads as a recap, not the same failure printed twice.
  for (const w of result.warnings) console.warn(`⚠ 고정 실패 — ${w.key}: ${w.error}`);
  if (result.quotaBlocked) {
    const { needed, available, resetsAt } = result.quotaBlocked;
    // `available` (remaining − inFlight) can be negative when a stale in-flight row overcounts —
    // clamp only the displayed number; the refusal itself already happened on the raw comparison.
    console.warn(`⚠ X was not sent: this batch needs ${needed} publish(es) and the account has ${Math.max(0, available)} left${resetsAt ? ` until ${resetsAt}` : ""}.`);
  }
} finally {
  await db.close();
}
