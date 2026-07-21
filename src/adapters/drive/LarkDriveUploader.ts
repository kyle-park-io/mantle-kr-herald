import type { FolderKind, UploadRequest, UploadResult } from "../../domain/publish/publishModels";
import type { DriveUploader } from "../../ports/DriveUploader";

interface TokenSource {
  getToken(): Promise<string>;
}

export class LarkDriveUploader implements DriveUploader {
  readonly name = "lark";

  constructor(
    private readonly auth: TokenSource,
    private readonly baseUrl: string,
    private readonly folders: Record<FolderKind, string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async upload(req: UploadRequest): Promise<UploadResult> {
    const token = await this.auth.getToken();
    const bytes = Buffer.from(req.content, "utf8");
    const form = new FormData();
    form.append("file_name", req.name);
    form.append("parent_type", "explorer");
    form.append("parent_node", this.folders[req.folder]);
    form.append("size", String(bytes.length));
    form.append("file", new Blob([bytes], { type: "text/markdown" }), req.name);

    const res = await this.fetchFn(`${this.baseUrl}/open-apis/drive/v1/files/upload_all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) {
      const detail = await extractLarkErrorDetail(res);
      throw new Error(`Lark Drive upload failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const data = (await res.json()) as { code?: number; msg?: string; data?: { file_token?: string } };
    if (data.code !== 0 || !data.data?.file_token) {
      throw new Error(`Lark Drive upload failed: code=${data.code} ${data.msg ?? ""}`.trim());
    }
    return { id: data.data.file_token, name: req.name };
  }

  /**
   * Replace, not edit in place. Lark's drive/v1 has no content-replace endpoint — a same-name
   * upload_all creates a duplicate, PUT on the file 404s, and PATCH rejects every documented-looking
   * body with 981002 — so the new content goes up as a new file and the old one is deleted. The
   * file_token therefore changes on every republish, unlike Google's PATCH against a stable id.
   *
   * Upload runs first: the failure it allows is an orphan (two files, one of them stale), which is
   * recoverable by hand, where delete-first would allow a window with no file at all in a folder
   * reviewers read from.
   */
  async update(remoteId: string, req: UploadRequest): Promise<UploadResult> {
    const result = await this.upload(req);
    await this.deletePrevious(remoteId, result.name);
    return result;
  }

  /**
   * Warns rather than throwing. PublishTranslations records the ledger row only when update()
   * returns, so throwing here would leave the file just uploaded unrecorded and the next run would
   * upload another copy — duplicates compounding on every run, which is what the sync ledger exists
   * to prevent. Warning keeps the ledger pointing at the live file and leaves at most one orphan.
   *
   * Because every failure is handled the same way, this never has to tell "already deleted by hand"
   * apart from "permission denied".
   */
  private async deletePrevious(remoteId: string, newName: string): Promise<void> {
    let detail = "";
    try {
      const token = await this.auth.getToken();
      const res = await this.fetchFn(
        `${this.baseUrl}/open-apis/drive/v1/files/${encodeURIComponent(remoteId)}?type=file`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const body = await extractLarkErrorDetail(res);
        detail = `HTTP ${res.status}${body ? ` — ${body}` : ""}`;
      } else {
        const data = (await res.json()) as { code?: number; msg?: string };
        if (data.code !== 0) detail = `code=${data.code} ${data.msg ?? ""}`.trim();
      }
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    if (detail) {
      console.warn(
        `[lark] published ${newName} but could not delete the previous file ${remoteId}: ${detail} — ` +
          `delete it in Lark Drive by hand, or the folder will keep two copies of this item`,
      );
    }
  }
}

/**
 * Pull Lark's `{ code, msg }` out of an HTTP-error body so a 403 reports (e.g.) "code=1061004
 * forbidden" rather than a bare status. Mirrors GoogleDriveUploader's extractErrorDetail; a
 * non-JSON body (a gateway HTML page) leaves the status as the only detail.
 */
async function extractLarkErrorDetail(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { code?: number; msg?: string };
    if (b.code == null && !b.msg) return "";
    return `code=${b.code} ${b.msg ?? ""}`.trim();
  } catch {
    return "";
  }
}
