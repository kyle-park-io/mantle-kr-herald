import { describe, it, expect } from "vitest";
import { GoogleDriveProvisioner } from "../../../src/adapters/drive/GoogleDriveProvisioner";

const auth = { getToken: async () => "ya29.tok" };

function fakeFetch(capture: { url?: string; headers?: Record<string, string>; body?: string }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.url = String(url);
    capture.headers = init?.headers as Record<string, string>;
    capture.body = String(init?.body ?? "");
    return new Response(JSON.stringify({ id: "folder123", name: "Mantle KR — review" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("GoogleDriveProvisioner", () => {
  describe("createFolder", () => {
    it("POSTs a folder-mimeType request with bearer token and returns id/name", async () => {
      const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};
      const provisioner = new GoogleDriveProvisioner(auth, fakeFetch(cap));

      const result = await provisioner.createFolder("Mantle KR — review");

      expect(cap.url).toBe("https://www.googleapis.com/drive/v3/files");
      expect(cap.headers?.["Authorization"]).toBe("Bearer ya29.tok");
      expect(cap.headers?.["Content-Type"]).toBe("application/json");
      expect(cap.body).toContain('"mimeType":"application/vnd.google-apps.folder"');
      expect(cap.body).toContain('"name":"Mantle KR — review"');
      expect(result).toEqual({ id: "folder123", name: "Mantle KR — review" });
    });

    it("throws on a non-ok response", async () => {
      const badFetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
      const provisioner = new GoogleDriveProvisioner(auth, badFetch);
      await expect(provisioner.createFolder("x")).rejects.toThrow(/403/);
    });
  });

  describe("findFolder", () => {
    it("GETs a folder-mimeType query with bearer token and returns the first match", async () => {
      const cap: { url?: string; method?: string; headers?: Record<string, string> } = {};
      const fetchFn = (async (url: string, init?: RequestInit) => {
        cap.url = String(url);
        cap.method = init?.method;
        cap.headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ files: [{ id: "fold1", name: "Mantle KR — review" }] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const provisioner = new GoogleDriveProvisioner(auth, fetchFn);

      const result = await provisioner.findFolder("Mantle KR — review");

      expect(result).toEqual({ id: "fold1", name: "Mantle KR — review" });
      expect(cap.url?.startsWith("https://www.googleapis.com/drive/v3/files")).toBe(true);
      expect(cap.method).toBe("GET");
      expect(cap.headers?.["Authorization"]).toBe("Bearer ya29.tok");
      expect(cap.url).toContain("q=");
      expect(cap.url).toContain("mimeType");
      expect(cap.url).toContain("vnd.google-apps.folder");
    });

    it("returns undefined when no folder matches", async () => {
      const fetchFn = (async () =>
        new Response(JSON.stringify({ files: [] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;
      const provisioner = new GoogleDriveProvisioner(auth, fetchFn);

      const result = await provisioner.findFolder("Mantle KR — review");

      expect(result).toBeUndefined();
    });

    it("throws on a non-ok response", async () => {
      const badFetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
      const provisioner = new GoogleDriveProvisioner(auth, badFetch);
      await expect(provisioner.findFolder("x")).rejects.toThrow(/403/);
    });
  });

  describe("share", () => {
    it("POSTs a permissions request with bearer token, defaulting role to writer", async () => {
      const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};
      const provisioner = new GoogleDriveProvisioner(auth, fakeFetch(cap));

      await provisioner.share("folder123", "a@b.com");

      expect(cap.url).toBe("https://www.googleapis.com/drive/v3/files/folder123/permissions?sendNotificationEmail=false");
      expect(cap.headers?.["Authorization"]).toBe("Bearer ya29.tok");
      expect(cap.headers?.["Content-Type"]).toBe("application/json");
      expect(JSON.parse(cap.body ?? "{}")).toEqual({ type: "user", role: "writer", emailAddress: "a@b.com" });
    });

    it("accepts an explicit reader role", async () => {
      const cap: { body?: string } = {};
      const provisioner = new GoogleDriveProvisioner(auth, fakeFetch(cap));
      await provisioner.share("folder123", "a@b.com", "reader");
      expect(JSON.parse(cap.body ?? "{}")).toEqual({ type: "user", role: "reader", emailAddress: "a@b.com" });
    });

    it("throws on a non-ok response", async () => {
      const badFetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
      const provisioner = new GoogleDriveProvisioner(auth, badFetch);
      await expect(provisioner.share("folder123", "a@b.com")).rejects.toThrow(/403/);
    });
  });
});
