import { describe, it, expect } from "vitest";
import { GoogleConfigDrive } from "../../src/adapters/drive/GoogleConfigDrive";
import type { TokenSource } from "../../src/adapters/drive/TokenSource";

const auth: TokenSource = { getToken: async () => "tok" };

function fakeFetch(handler: (url: string, init?: RequestInit) => { ok: boolean; status?: number; json?: unknown; text?: string }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.json, text: async () => r.text ?? "" } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("GoogleConfigDrive", () => {
  it("upload posts a multipart body carrying the name, parent, and content", async () => {
    const f = fakeFetch(() => ({ ok: true, json: { id: "F1" } }));
    const res = await new GoogleConfigDrive(auth, f.fn).upload("FOLDER", "steering-config-x.json", "{\"a\":1}");
    expect(res).toEqual({ id: "F1" });
    const body = String(f.calls[0].init!.body);
    expect(body).toContain("steering-config-x.json");
    expect(body).toContain("FOLDER");
    expect(body).toContain("{\"a\":1}");
    expect(f.calls[0].url).toContain("uploadType=multipart");
  });

  it("latest queries by folder+prefix ordered by createdTime desc and returns the first", async () => {
    const f = fakeFetch(() => ({ ok: true, json: { files: [{ id: "L1", name: "steering-config-2.json" }, { id: "L2", name: "steering-config-1.json" }] } }));
    const res = await new GoogleConfigDrive(auth, f.fn).latest("FOLDER", "steering-config-");
    expect(res).toEqual({ id: "L1", name: "steering-config-2.json" });
    expect(decodeURIComponent(f.calls[0].url)).toContain("'FOLDER' in parents");
    expect(decodeURIComponent(f.calls[0].url)).toContain("createdTime desc");
  });

  it("latest returns undefined on an empty folder", async () => {
    const f = fakeFetch(() => ({ ok: true, json: { files: [] } }));
    expect(await new GoogleConfigDrive(auth, f.fn).latest("FOLDER", "steering-config-")).toBeUndefined();
  });

  it("download GETs ?alt=media and returns the body text", async () => {
    const f = fakeFetch(() => ({ ok: true, text: "BUNDLE" }));
    expect(await new GoogleConfigDrive(auth, f.fn).download("F1")).toBe("BUNDLE");
    expect(f.calls[0].url).toContain("/F1?alt=media");
  });

  it("surfaces a non-ok upload", async () => {
    const f = fakeFetch(() => ({ ok: false, status: 403, text: "denied" }));
    await expect(new GoogleConfigDrive(auth, f.fn).upload("F", "n", "c")).rejects.toThrow(/403/);
  });

  it("says `config` by default, so the existing commands read as before", async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }));
    await expect(new GoogleConfigDrive(auth, f.fn).download("F1")).rejects.toThrow("config download failed: HTTP 404");
  });

  it("names the bundle it was given, so a stale folder id points at the right env var", async () => {
    // The likeliest operational-state failure is a stale GDRIVE_STATE_FOLDER_ID. Reporting it as a
    // `config download failed` would send the operator to check GDRIVE_CONFIG_FOLDER_ID instead.
    const drive = new GoogleConfigDrive(auth, fakeFetch(() => ({ ok: false, status: 404 })).fn, "operational-state");
    await expect(drive.download("F1")).rejects.toThrow("operational-state download failed: HTTP 404");

    const listing = new GoogleConfigDrive(auth, fakeFetch(() => ({ ok: false, status: 404 })).fn, "operational-state");
    await expect(listing.latest("F", "p")).rejects.toThrow("operational-state list failed: HTTP 404");

    const upload = new GoogleConfigDrive(auth, fakeFetch(() => ({ ok: false, status: 403, text: "x" })).fn, "operational-state");
    await expect(upload.upload("F", "n", "c")).rejects.toThrow(/^operational-state upload failed/);

    const noId = new GoogleConfigDrive(auth, fakeFetch(() => ({ ok: true, json: {} })).fn, "operational-state");
    await expect(noId.upload("F", "n", "c")).rejects.toThrow("operational-state upload response missing id");
  });
});
