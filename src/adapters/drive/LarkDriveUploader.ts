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
    const data = (await res.json()) as { code?: number; msg?: string; data?: { file_token?: string } };
    if (data.code !== 0 || !data.data?.file_token) {
      throw new Error(`Lark Drive upload failed: code=${data.code} ${data.msg ?? ""}`.trim());
    }
    return { id: data.data.file_token, name: req.name };
  }
}
