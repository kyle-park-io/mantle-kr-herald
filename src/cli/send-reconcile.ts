import "./registerErrorHandler";
import { paths } from "../paths";
import { loadTypefullyConfig } from "../config";
import { JsonChannelLedger } from "../adapters/store/JsonChannelLedger";
import { JsonXArticleLedger } from "../adapters/store/JsonXArticleLedger";
import { TypefullyDraftLookup } from "../adapters/send/TypefullyDraftLookup";
import { ReconcilePublished } from "../app/ReconcilePublished";

const c = loadTypefullyConfig();
const result = await new ReconcilePublished(
  new JsonChannelLedger(paths.publishDir),
  new JsonXArticleLedger(paths.publishDir),
  new TypefullyDraftLookup(c.apiKey, c.socialSetId),
).run();
console.log(`send:reconcile — reconciled ${result.reconciled} · pending ${result.pending} (not published yet)`);
