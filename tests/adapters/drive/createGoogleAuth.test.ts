import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleAuth } from "../../../src/adapters/drive/createGoogleAuth";
import { GoogleOAuthAuth } from "../../../src/adapters/drive/GoogleOAuthAuth";
import { GoogleServiceAccountAuth } from "../../../src/adapters/drive/GoogleServiceAccountAuth";

describe("createGoogleAuth", () => {
  it("builds a GoogleOAuthAuth for an oauth config", async () => {
    const auth = await createGoogleAuth({
      mode: "oauth",
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
    });
    expect(auth).toBeInstanceOf(GoogleOAuthAuth);
  });

  describe("service_account config", () => {
    let keyFile: string | undefined;

    afterEach(async () => {
      if (keyFile) await unlink(keyFile);
      keyFile = undefined;
    });

    it("builds a GoogleServiceAccountAuth from the key file", async () => {
      keyFile = join(tmpdir(), `sa-key-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      await writeFile(keyFile, JSON.stringify({ client_email: "a@b", private_key: "k" }));

      const auth = await createGoogleAuth({ mode: "service_account", saKeyFile: keyFile });

      expect(auth).toBeInstanceOf(GoogleServiceAccountAuth);
    });
  });
});
