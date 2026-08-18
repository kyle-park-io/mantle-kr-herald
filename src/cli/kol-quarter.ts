import "./registerErrorHandler";
import { skipIfLocal } from "./skipIfLocal";
import { argValue } from "./args";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TmePreviewGateway } from "../adapters/telegram/TmePreviewGateway";
import { SweepKolQuarter, emptySweepFailure } from "../app/SweepKolQuarter";

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

// No rendering source is wired up to this command yet — passed explicitly (rather than defaulted
// deep inside SweepKolQuarter) so this is a visible decision, not a silent omission. Every row this
// run newly records gets a blank itemId/topic/matchScore; SweepKolQuarter warns about this itself.
const report = await new SweepKolQuarter(sheet, gateway).run({ quarter, renderings: [] });

console.log(`kol-quarter sweep for ${report.quarter}: roster ${report.rosterSize} KOL(s)`);
for (const m of report.months) {
  const unresolvedNote = m.unresolved.length > 0 ? ` (unresolved: ${m.unresolved.join(", ")})` : "";
  const rejectedNote = m.rejected > 0 ? `, ${m.rejected} rejected post(s) skipped` : "";
  console.log(`  ${m.month}: ${m.written} written${rejectedNote}${unresolvedNote}`);

  // The log region is full. Printed per month and failed on below: these posts are not in the log
  // and no summary formula can see them, so a run that only warned would keep under-reporting
  // every KOL's count for the rest of the quarter while still exiting 0.
  if (m.overflow.length > 0) {
    console.log(`    log region full — ${m.overflow.length} post(s) could not be given a row:`);
    for (const link of m.overflow) console.log(`      ${link}`);
  }

  // The five counters `RecordKolTelegramPosts` itself computes for this month's sweep — printed in
  // full, same posture as kol-telegram-record.ts: a silent zero here must never be mistaken for "no
  // posts this month" when the real story is "every channel failed" or "the sweep was truncated",
  // either of which would otherwise surface only as a false shortfall further down this report.
  const r = m.recorded;
  const failureCallout = r.channelsFailed > 0 ? " — see warnings above" : "";
  const truncationCallout = r.channelsTruncated > 0 ? " — see warnings above" : "";
  console.log(
    `    telegram sweep: ${r.created} created, ${r.refreshed} refreshed, ${r.channelsSwept} channel(s) swept, ` +
      `${r.channelsFailed} channel(s) failed${failureCallout}, ${r.channelsTruncated} channel(s) truncated${truncationCallout}.`,
  );
}

if (report.contractError) {
  console.log(`shortfalls: unknown — could not read this quarter's contract targets (${report.contractError})`);
} else if (report.shortfalls.length > 0) {
  console.log("shortfalls:");
  for (const s of report.shortfalls) {
    console.log(`  ${s.month} ${s.kolName} ${s.actual}/${s.required}`);
  }
} else {
  console.log("shortfalls: none");
}

if (report.unmatchedContractNames.length > 0) {
  console.log("contract names with no matching roster entry (not compared, not a shortfall):");
  for (const u of report.unmatchedContractNames) {
    console.log(`  ${u.month} ${u.kolName} (requires ${u.required})`);
  }
}

if (report.unknownTargets.length > 0) {
  console.log("unknown targets (contract deliverable text this run could not parse):");
  for (const u of report.unknownTargets) {
    console.log(`  ${u.month} ${u.kolName}: ${JSON.stringify(u.raw)}`);
  }
}

// The two states that must reach systemd rather than a log nobody reads. `kol:quarter` fires
// unattended every Tuesday, and `herald-kol-weekly.service`'s
// `OnFailure=herald-notify-failure@%n.service` is the only signal it ever sends — so "swept
// nothing" and "the log is full" have to be non-zero exits, not warnings. A shortfall is NOT one
// of them: a KOL falling short is a finding for a human, and the run that found it worked.
const sweptNothing = emptySweepFailure(report);
if (sweptNothing) console.error(`✖ kol-quarter: ${sweptNothing}`);

const overflowed = report.months.filter((m) => m.overflow.length > 0);
if (overflowed.length > 0) {
  console.error(
    `✖ kol-quarter: the monthly log region is full in ${overflowed.map((m) => m.month).join(", ")} — ` +
      `nothing was written past row 1963 and no existing row was overwritten, but the posts listed ` +
      `above are unlogged until a human extends the summary formulas' range (and the three per-row ` +
      `formula columns) past that row, or archives the tab.`,
  );
}

if (sweptNothing || overflowed.length > 0) process.exitCode = 1;
