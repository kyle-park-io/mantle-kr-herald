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
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name: req.name, parents: [this.folders[req.folder]] });
    const body =
      `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      "Content-Type: text/markdown; charset=UTF-8\r\n\r\n" +
      `${req.content}\r\n` +
      `--${boundary}--`;

    const res = await this.fetchFn(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const b = (await res.json()) as { error?: { message?: string } };
        detail = b.error?.message ?? "";
      } catch {
        // non-JSON body — status alone is the detail
      }
      throw new Error(`Google Drive upload failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const data = (await res.json()) as { id?: string; name?: string; webViewLink?: string };
    if (!data.id) throw new Error("Google Drive upload response missing id");
    return { id: data.id, name: data.name ?? req.name, url: data.webViewLink };
  }
}
