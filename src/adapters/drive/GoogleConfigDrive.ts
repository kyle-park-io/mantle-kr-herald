import { z } from "zod";
import type { TokenSource } from "./TokenSource";
import type { ConfigDrive } from "../../ports/ConfigDrive";

const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";

function multipartBody(metadata: object, content: string): { boundary: string; body: string } {
  const boundary = `cfg${Date.now()}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  return { boundary, body };
}

const ListSchema = z.object({ files: z.array(z.object({ id: z.string(), name: z.string() })).nullish() });

export class GoogleConfigDrive implements ConfigDrive {
  constructor(private readonly auth: TokenSource, private readonly fetchFn: typeof fetch = fetch) {}

  async upload(folderId: string, name: string, content: string): Promise<{ id: string }> {
    const token = await this.auth.getToken();
    const { boundary, body } = multipartBody({ name, parents: [folderId] }, content);
    const res = await this.fetchFn(UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`config upload failed: HTTP ${res.status} — ${await res.text()}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("config upload response missing id");
    return { id: data.id };
  }

  async latest(folderId: string, prefix: string): Promise<{ id: string; name: string } | undefined> {
    const token = await this.auth.getToken();
    const q = `'${folderId}' in parents and name contains '${prefix}' and trashed = false`;
    const url = `${FILES_URL}?q=${encodeURIComponent(q)}&orderBy=${encodeURIComponent("createdTime desc")}&pageSize=1&fields=${encodeURIComponent("files(id,name)")}`;
    const res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`config list failed: HTTP ${res.status}`);
    const data = ListSchema.parse(await res.json());
    return (data.files ?? [])[0];
  }

  async download(fileId: string): Promise<string> {
    const token = await this.auth.getToken();
    const res = await this.fetchFn(`${FILES_URL}/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`config download failed: HTTP ${res.status}`);
    return await res.text();
  }
}
