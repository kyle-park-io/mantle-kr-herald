import "./registerErrorHandler";
import { loadTypefullyConfig, loadDbConfig } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { TypefullyDraftLookup } from "../adapters/send/TypefullyDraftLookup";
import { ReconcilePublished } from "../app/ReconcilePublished";

const c = loadTypefullyConfig();

const db = createDb(loadDbConfig());
try {
  const stores = createStores(db);
  const result = await new ReconcilePublished(
    stores.deliveryLedger,
    stores.xArticleLedger,
    new TypefullyDraftLookup(c.apiKey, c.socialSetId),
  ).run();
  // `retired` gets its own Korean label, matching the board's `예약 취소됨` badge for the same
  // `dropped`/`droppedAt` row — a retirement that only ever surfaces as a plain number here is the
  // same class of bug as PR #85's `발송됨` that had not actually happened: it reads as routine when it
  // is in fact a slot of the account's 15/month quota being given back because a draft was deleted.
  console.log(
    `send:reconcile — reconciled ${result.reconciled} · retired ${result.retired} (예약 취소됨 — Typefully 초안 삭제) · pending ${result.pending} (not published yet)`,
  );
} finally {
  await db.close();
}
