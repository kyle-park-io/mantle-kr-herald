import { describe, it, expect, vi } from "vitest";
import { LarkDriveUploader } from "../../../src/adapters/drive/LarkDriveUploader";

const auth = { getToken: async () => "t-lark" };
const folders = { review: "REVIEW_TOKEN", approved: "APPROVED_TOKEN" };

function fakeFetch(capture: { url?: string; headers?: Record<string, string>; form?: FormData }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.url = String(url);
    capture.headers = init?.headers as Record<string, string>;
    capture.form = init?.body as FormData;
    return new Response(JSON.stringify({ code: 0, data: { file_token: "flk_1" } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

interface Call {
  url: string;
  method: string;
  form?: FormData;
}

/**
 * Records every call, unlike fakeFetch which keeps only the last. update() makes two requests, and
 * one test asserts a request was never made.
 */
function recordingFetch(calls: Call[], responses: Response[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      form: init?.body instanceof FormData ? init.body : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("recordingFetch: no response queued");
    return next;
  }) as unknown as typeof fetch;
}

const okUpload = (fileToken: string) =>
  new Response(JSON.stringify({ code: 0, data: { file_token: fileToken } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const okDelete = () =>
  new Response(JSON.stringify({ code: 0, data: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("LarkDriveUploader", () => {
  it("uploads multipart/form-data to upload_all with the review folder token", async () => {
    const cap: { url?: string; headers?: Record<string, string>; form?: FormData } = {};
    const uploader = new LarkDriveUploader(auth, "https://open.larksuite.com", folders, fakeFetch(cap));

    const result = await uploader.upload({ name: "x-1.md", content: "# hi", folder: "review" });

    expect(uploader.name).toBe("lark");
    expect(cap.url).toBe("https://open.larksuite.com/open-apis/drive/v1/files/upload_all");
    expect(cap.headers?.["Authorization"]).toBe("Bearer t-lark");
    expect(cap.form?.get("file_name")).toBe("x-1.md");
    expect(cap.form?.get("parent_type")).toBe("explorer");
    expect(cap.form?.get("parent_node")).toBe("REVIEW_TOKEN");
    expect(cap.form?.get("size")).toBe(String(Buffer.byteLength("# hi", "utf8")));
    expect(result).toEqual({ id: "flk_1", name: "x-1.md" });
  });

  it("throws when the Lark envelope code is non-zero", async () => {
    const badFetch = (async () =>
      new Response(JSON.stringify({ code: 1061045, msg: "no permission" }), { status: 200 })) as unknown as typeof fetch;
    const uploader = new LarkDriveUploader(auth, "https://open.larksuite.com", folders, badFetch);
    await expect(uploader.upload({ name: "n", content: "c", folder: "review" })).rejects.toThrow(/1061045|no permission/);
  });

  it("surfaces the Lark error code and message on an HTTP error status", async () => {
    // A 403 carries the real reason (e.g. code 1061004 forbidden) in its JSON body; discarding it
    // and throwing only "HTTP 403" hides whether the cause is a missing scope or an unshared folder.
    const badFetch = (async () =>
      new Response(JSON.stringify({ code: 1061004, msg: "forbidden." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const uploader = new LarkDriveUploader(auth, "https://open.larksuite.com", folders, badFetch);

    const err = (await uploader.upload({ name: "n", content: "c", folder: "review" }).catch((e) => e)) as Error;

    expect(err.message).toContain("403");
    expect(err.message).toContain("1061004");
    expect(err.message).toContain("forbidden.");
  });

  it("still reports the HTTP status when the error body is not JSON", async () => {
    const badFetch = (async () =>
      new Response("<html>gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const uploader = new LarkDriveUploader(auth, "https://open.larksuite.com", folders, badFetch);
    await expect(uploader.upload({ name: "n", content: "c", folder: "review" })).rejects.toThrow(/502/);
  });
});

describe("LarkDriveUploader.update", () => {
  it("uploads the new content and returns the new file token", async () => {
    const calls: Call[] = [];
    const uploader = new LarkDriveUploader(
      auth,
      "https://open.larksuite.com",
      folders,
      recordingFetch(calls, [okUpload("flk_new"), okDelete()]),
    );

    const result = await uploader.update("flk_old", { name: "x-1.md", content: "# v2", folder: "approved" });

    expect(result).toEqual({ id: "flk_new", name: "x-1.md" });
    expect(calls[0].url).toBe("https://open.larksuite.com/open-apis/drive/v1/files/upload_all");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].form?.get("parent_node")).toBe("APPROVED_TOKEN");
  });

  it("deletes the previous file by token, as type=file", async () => {
    const calls: Call[] = [];
    const uploader = new LarkDriveUploader(
      auth,
      "https://open.larksuite.com",
      folders,
      recordingFetch(calls, [okUpload("flk_new"), okDelete()]),
    );

    await uploader.update("flk_old", { name: "x-1.md", content: "# v2", folder: "review" });

    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("DELETE");
    expect(calls[1].url).toBe("https://open.larksuite.com/open-apis/drive/v1/files/flk_old?type=file");
  });

  it("does not delete the previous file when the upload fails", async () => {
    // Deleting after a failed upload would destroy the only published copy.
    const calls: Call[] = [];
    const uploader = new LarkDriveUploader(
      auth,
      "https://open.larksuite.com",
      folders,
      recordingFetch(calls, [
        new Response(JSON.stringify({ code: 1061004, msg: "forbidden." }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ]),
    );

    await expect(uploader.update("flk_old", { name: "n", content: "c", folder: "review" })).rejects.toThrow(/1061004/);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
  });

  it("returns the new result and warns when deleting the previous file fails", async () => {
    // PublishTranslations records the ledger row only when update() returns. Throwing here would
    // leave the file just uploaded unrecorded, so the next run would upload yet another copy.
    const calls: Call[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const uploader = new LarkDriveUploader(
      auth,
      "https://open.larksuite.com",
      folders,
      recordingFetch(calls, [
        okUpload("flk_new"),
        new Response(JSON.stringify({ code: 1061045, msg: "no permission" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ]),
    );

    const result = await uploader.update("flk_old", { name: "x-1.md", content: "# v2", folder: "review" });

    expect(result).toEqual({ id: "flk_new", name: "x-1.md" });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("flk_old");
    expect(message).toContain("1061045");
    warn.mockRestore();
  });
});
