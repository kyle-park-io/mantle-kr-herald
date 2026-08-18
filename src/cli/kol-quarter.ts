import "./registerErrorHandler";
import { skipIfLocal } from "./skipIfLocal";
import { argValue } from "./args";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TmePreviewGateway } from "../adapters/telegram/TmePreviewGateway";
import { SweepKolQuarter } from "../app/SweepKolQuarter";

skipIfLocal("kol-quarter");

/** `"2026-Q3"` for any date from Jul 1 through Sep 30 (UTC) — the quarter --quarter defaults to. */
function currentQuarter(now: Date): string {
  const quarterNumber = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${now.getUTCFullYear()}-Q${quarterNumber}`;
}

const quarter = argValue("--quarter") ?? currentQuarter(new Date());

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const sheet = new GoogleSheetClient(auth, loadGoogleSheetConfig().spreadsheetId);
const gateway = new TmePreviewGateway();

const report = await new SweepKolQuarter(sheet, gateway).run({ quarter });

console.log(`kol-quarter sweep for ${report.quarter}:`);
for (const m of report.months) {
  const unresolvedNote = m.unresolved.length > 0 ? ` (unresolved: ${m.unresolved.join(", ")})` : "";
  console.log(`  ${m.month}: ${m.written} written${unresolvedNote}`);
}

if (report.shortfalls.length > 0) {
  console.log("shortfalls:");
  for (const s of report.shortfalls) {
    console.log(`  ${s.month} ${s.kolName} ${s.actual}/${s.required}`);
  }
} else {
  console.log("shortfalls: none");
}

if (report.unknownTargets.length > 0) {
  console.log("unknown targets (contract deliverable text this run could not parse):");
  for (const u of report.unknownTargets) {
    console.log(`  ${u.month} ${u.kolName}: ${JSON.stringify(u.raw)}`);
  }
}
