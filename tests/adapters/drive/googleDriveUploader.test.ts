import { describe, it, expect } from "vitest";
import { GoogleDriveUploader } from "../../../src/adapters/drive/GoogleDriveUploader";

const auth = { getToken: async () => "ya29.tok" };
const folders = { review: "REVIEW_FOLDER", approved: "APPROVED_FOLDER" };

function fakeFetch(capture: { url?: string; headers?: Record<string, string>; body?: string }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.url = String(url);
    capture.headers = init?.headers as Record<string, string>;
    capture.body = String(init?.body ?? "");
    return new Response(
      JSON.stringify({ id: "file123", name: "x-1.md", webViewLink: "https://drive.google.com/file/d/file123/view" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("GoogleDriveUploader", () => {
  it("uploads multipart/related with bearer token and the review folder as parent", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const uploader = new GoogleDriveUploader(auth, folders, fakeFetch(cap));

    const result = await uploader.upload({ name: "x-1.md", content: "# hi", folder: "review" });

    expect(uploader.name).toBe("google");
    expect(cap.url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink");
    expect(cap.headers?.["Authorization"]).toBe("Bearer ya29.tok");
    expect(cap.headers?.["Content-Type"]).toContain("multipart/related; boundary=");
    expect(cap.body).toContain('"name":"x-1.md"');
    expect(cap.body).toContain('"parents":["REVIEW_FOLDER"]');
    expect(cap.body).toContain("# hi");
    expect(result).toEqual({ id: "file123", name: "x-1.md", url: "https://drive.google.com/file/d/file123/view" });
  });

  it("maps the approved folder", async () => {
    const cap: { body?: string } = {};
    const uploader = new GoogleDriveUploader(auth, folders, fakeFetch(cap));
    await uploader.upload({ name: "x-2.md", content: "c", folder: "approved" });
    expect(cap.body).toContain('"parents":["APPROVED_FOLDER"]');
  });

  it("throws on a non-ok response", async () => {
    const badFetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const uploader = new GoogleDriveUploader(auth, folders, badFetch);
    await expect(uploader.upload({ name: "n", content: "c", folder: "review" })).rejects.toThrow(/403/);
  });

  it("updates an existing file in place with a multipart PATCH against its id", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const uploader = new GoogleDriveUploader(auth, folders, fakeFetch(cap));

    const result = await uploader.update("file123", { name: "x-1.md", content: "# updated", folder: "approved" });

    expect(cap.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files/file123?uploadType=multipart&fields=id,name,webViewLink",
    );
    expect(cap.headers?.["Authorization"]).toBe("Bearer ya29.tok");
    expect(cap.headers?.["Content-Type"]).toContain("multipart/related; boundary=");
    expect(cap.body).toContain("# updated");
    expect(result).toEqual({
      id: "file123",
      name: "x-1.md",
      url: "https://drive.google.com/file/d/file123/view",
    });
  });

  it("sends the new name but never a parents field, which a metadata PATCH cannot move", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};

    await new GoogleDriveUploader(auth, folders, fakeFetch(cap))
      .update("file123", { name: "renamed.md", content: "# updated", folder: "approved" });

    expect(cap.body).toContain('"name":"renamed.md"');
    // Drive moves a file with addParents/removeParents query params; a parents field in the
    // metadata body is either rejected or silently dropped, so it must not be sent.
    expect(cap.body).not.toContain("parents");
    expect(cap.body).not.toContain("APPROVED_FOLDER");
  });

  it("percent-encodes the remote id in the URL", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};

    await new GoogleDriveUploader(auth, folders, fakeFetch(cap))
      .update("a/b", { name: "x-1.md", content: "x", folder: "approved" });

    expect(cap.url).toContain("/files/a%2Fb?");
  });

  it("surfaces the API error message when an update fails", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: "File not found: file123." } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(
      new GoogleDriveUploader(auth, folders, failing).update("file123", {
        name: "x-1.md",
        content: "x",
        folder: "approved",
      }),
    ).rejects.toThrow(/404.*File not found/);
  });
});
