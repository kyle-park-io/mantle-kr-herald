import "./registerErrorHandler";
import { argValue, parseList } from "./args";
import { paths } from "../paths";
import { loadTelegramChatIds, loadXMaxWeighted } from "../config";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonDeliveryLedger } from "../adapters/store/JsonDeliveryLedger";
import { ALL_OUTLETS, deliveredByChannelSender, outletById, outletsForChannel } from "../domain/outlet/models";
import { SendChannels } from "../app/SendChannels";
import { resolveChannelTargets, createSenders } from "./channelSenders";
import { buildRecorder } from "./recorder";
import { buildArchiver } from "./archiver";

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

const senders = createSenders(targets);
const idsArg = argValue("--ids");
const ids = idsArg ? new Set(idsArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) : undefined;

const store = new JsonFormattingStore(paths.formattedDir);
const ledger = new JsonDeliveryLedger(paths.publishDir);
const record = await buildRecorder();
const archive = await buildArchiver();

const result = await new SendChannels(
  store,
  senders,
  ledger,
  record,
  archive,
  undefined,
  loadXMaxWeighted(),
  outletsForChannel,
  loadTelegramChatIds(),
).run({ targets, ids, outletIds });
// The extra segments appear only when they happened, so an ordinary run prints the line it always
// printed. Both are kept out of `failed`: neither is a send that went wrong.
const parts = [`sent ${result.sent}`, `skipped ${result.skipped} (already sent)`, `failed ${result.failed}`];
if (result.unconfigured > 0) parts.push(`미설정 ${result.unconfigured} (${result.unconfiguredEnv.join(", ")})`);
if (result.withheld > 0) parts.push(`보류 ${result.withheld} (첫 발송 — --outlets 로 방을 지정하세요)`);
console.log(parts.join(" · "));
