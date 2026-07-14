import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { GoogleAuth } from "../../../src/adapters/drive/GoogleAuth";

const saKeyFile = process.env.GOOGLE_SA_KEY_FILE;

// Skipped unless a Google service-account key file is configured.
describe.skipIf(!saKeyFile)("PROBE: Google service-account auth", () => {
  it("mints a real access token from the service account key", async () => {
    await readFile(saKeyFile!, "utf8"); // fail fast if unreadable
    const auth = await GoogleAuth.fromKeyFile(saKeyFile!);
    const token = await auth.getToken();
    // eslint-disable-next-line no-console
    console.log(`[probe] Google token acquired (len ${token.length})`);
    expect(token.length).toBeGreaterThan(0);
  }, 30000);
});
