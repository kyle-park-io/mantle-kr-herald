import type { FolderKind, UploadRequest, UploadResult } from "../../domain/publish/publishModels";
import type { DriveUploader } from "../../ports/DriveUploader";

const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink";

interface TokenSource {
  getToken(): Promise<string>;
}

export class GoogleDriveUploader implements DriveUploader {
  readonly name = "google";

  constructor(
    private readonly auth: TokenSource,
    private readonly folders: Record<FolderKind, string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async upload(req: UploadRequest): Promise<UploadResult> {
    const token = await this.auth.getToken();
    const { boundary, body } = multipartBody({ name: req.name, parents: [this.folders[req.folder]] }, req.content);

    const res = await this.fetchFn(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new Error(`Google Drive upload failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const data = (await res.json()) as { id?: string; name?: string; webViewLink?: string };
    if (!data.id) throw new Error("Google Drive upload response missing id");
    return { id: data.id, name: data.name ?? req.name, url: data.webViewLink };
  }

  /**
   * Multipart PATCH against the existing file id. Addressing the file by id is what preserves
   * webViewLink — and therefore any link already written into the Sheet history tab.
   * Metadata carries `name` only: `publishFileName` can change when approvedAt changes, but
   * parents must move via addParents/removeParents query params, never a metadata field.
   */
  async update(remoteId: string, req: UploadRequest): Promise<UploadResult> {
    const token = await this.auth.getToken();
    const { boundary, body } = multipartBody({ name: req.name }, req.content);

    const url =
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(remoteId)}` +
      "?uploadType=multipart&fields=id,name,webViewLink";

    const res = await this.fetchFn(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new Error(`Google Drive update failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const data = (await res.json()) as { id?: string; name?: string; webViewLink?: string };
    return { id: data.id ?? remoteId, name: data.name ?? req.name, url: data.webViewLink };
  }
}

async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { error?: { message?: string } };
    return b.error?.message ?? "";
  } catch {
    // non-JSON body — status alone is the detail
    return "";
  }
}

/**
 * Frame a Drive multipart/related body: a JSON metadata part followed by the file content part.
 * Shared by `upload` (create) and `update` (PATCH) — the only difference between the two calls is
 * what `metadata` contains (`parents` present vs absent), never the framing itself.
 */
function multipartBody(metadata: object, content: string): { boundary: string; body: string } {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: text/markdown; charset=UTF-8\r\n\r\n" +
    `${content}\r\n` +
    `--${boundary}--`;
  return { boundary, body };
}
