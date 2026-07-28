import "./registerErrorHandler";
import { argValue } from "./args";
import { paths } from "../paths";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonChannelLedger } from "../adapters/store/JsonChannelLedger";
import { SendChannels } from "../app/SendChannels";
import { resolveChannelTargets, createSenders } from "./channelSenders";
import { buildRecorder } from "./recorder";
import { buildArchiver } from "./archiver";

const targets = resolveChannelTargets(argValue("--target"));
const senders = createSenders(targets);
const idsArg = argValue("--ids");
const ids = idsArg ? new Set(idsArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) : undefined;

const store = new JsonFormattingStore(paths.formattedDir);
const ledger = new JsonChannelLedger(paths.publishDir);
const record = await buildRecorder();
const archive = await buildArchiver();

const result = await new SendChannels(store, senders, ledger, record, archive).run({ targets, ids });
console.log(`sent ${result.sent} · skipped ${result.skipped} (already sent) · failed ${result.failed}`);
