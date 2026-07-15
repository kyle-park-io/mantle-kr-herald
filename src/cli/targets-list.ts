import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { LoadTargets } from "../app/LoadTargets";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";

const activeOnly = process.argv.includes("--active-only");
const auth = await createGoogleAuth(loadGoogleAuthConfig());
const { spreadsheetId } = loadGoogleSheetConfig();

const targets = await new LoadTargets(new GoogleSheetClient(auth, spreadsheetId)).run({ activeOnly });

console.log(`${targets.length} target(s)${activeOnly ? " (active only)" : ""}:`);
for (const t of targets) {
  console.log(`  [${t.active ? "on " : "off"}] ${t.channel} · ${t.name} · ${t.address}${t.notes ? ` (${t.notes})` : ""}`);
}
