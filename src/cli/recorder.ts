import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { RecordPublish } from "../app/RecordPublish";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import type { Recorder } from "../app/SendChannels";

/**
 * A best-effort history recorder: undefined unless GSHEET_ID + Google auth are configured, so a send
 * still works with no Sheet. History (§9b) is an add-on, not a prerequisite for delivery.
 */
export async function buildRecorder(): Promise<Recorder | undefined> {
  try {
    const { spreadsheetId } = loadGoogleSheetConfig();
    const auth = await createGoogleAuth(loadGoogleAuthConfig());
    const rp = new RecordPublish(new GoogleSheetClient(auth, spreadsheetId));
    return (rec) => rp.record(rec);
  } catch {
    return undefined;
  }
}
