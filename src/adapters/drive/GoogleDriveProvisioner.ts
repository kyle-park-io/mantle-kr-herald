interface TokenSource {
  getToken(): Promise<string>;
}

const FILES_URL = "https://www.googleapis.com/drive/v3/files";

export class GoogleDriveProvisioner {
  constructor(
    private readonly auth: TokenSource,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Create a Drive folder owned by the service account, optionally nested under parentId. */
  async createFolder(name: string, parentId?: string): Promise<{ id: string; name: string }> {
    const token = await this.auth.getToken();
    const body: { name: string; mimeType: string; parents?: string[] } = {
      name,
      mimeType: "application/vnd.google-apps.folder",
    };
    if (parentId) body.parents = [parentId];
    const res = await this.fetchFn(FILES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Google Drive createFolder failed: HTTP ${res.status}`);
    const data = (await res.json()) as { id?: string; name?: string };
    if (!data.id) throw new Error("Google Drive createFolder response missing id");
    return { id: data.id, name: data.name ?? name };
  }

  /** Find an SA-created folder by exact name (drive.file lists only app-created files), optionally scoped to a parent. Returns undefined if none. */
  async findFolder(name: string, parentId?: string): Promise<{ id: string; name: string } | undefined> {
    const token = await this.auth.getToken();
    let q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    const url = `${FILES_URL}?q=${encodeURIComponent(q)}&spaces=drive&fields=${encodeURIComponent("files(id,name)")}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Google Drive findFolder failed: HTTP ${res.status}`);
    const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
    const first = data.files?.[0];
    return first ? { id: first.id, name: first.name } : undefined;
  }

  /** Emails that already have a permission on this file — used to make re-sharing idempotent. */
  async listSharedEmails(fileId: string): Promise<Set<string>> {
    const token = await this.auth.getToken();
    const url = `${FILES_URL}/${fileId}/permissions?fields=${encodeURIComponent("permissions(emailAddress)")}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Google Drive list permissions failed: HTTP ${res.status}`);
    const data = (await res.json()) as { permissions?: Array<{ emailAddress?: string }> };
    return new Set(
      (data.permissions ?? [])
        .map((p) => p.emailAddress)
        .filter((e): e is string => typeof e === "string"),
    );
  }

  /** Share a file/folder with a user (role "writer" = editor, "reader" = viewer). No email notification. */
  async share(fileId: string, email: string, role: "writer" | "reader" = "writer"): Promise<void> {
    const token = await this.auth.getToken();
    const res = await this.fetchFn(`${FILES_URL}/${fileId}/permissions?sendNotificationEmail=false`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user", role, emailAddress: email }),
    });
    if (!res.ok) throw new Error(`Google Drive share failed: HTTP ${res.status}`);
  }
}
