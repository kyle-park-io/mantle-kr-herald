// src/adapters/web/publishLinks.ts
export interface PublishLinkConfig {
  google?: { reviewFolderId: string; approvedFolderId: string };
  lark?: { workspaceUrl: string; reviewFolderToken: string; approvedFolderToken: string };
}

export interface PublishRowInput {
  target: string; // "local" | "google" | "lark"
  status: string; // "translated" | "approved"
  url?: string; // Google webViewLink from the ledger
  remoteId?: string; // Google fileId / Lark file_token
}

/**
 * Folder- and file-open URLs for a published row. Pure. Folder selection mirrors
 * PublishTranslations: approved → the approved folder, otherwise the review folder.
 * Any missing input (no config, no remoteId) yields undefined for that URL — never a broken link.
 */
export function publishRowLinks(
  row: PublishRowInput,
  cfg: PublishLinkConfig,
): { folderUrl?: string; fileUrl?: string } {
  const approved = row.status === "approved";
  if (row.target === "google") {
    const folderId = cfg.google ? (approved ? cfg.google.approvedFolderId : cfg.google.reviewFolderId) : undefined;
    return {
      folderUrl: folderId ? `https://drive.google.com/drive/folders/${folderId}` : undefined,
      fileUrl: row.url,
    };
  }
  if (row.target === "lark") {
    if (!cfg.lark) return {};
    const token = approved ? cfg.lark.approvedFolderToken : cfg.lark.reviewFolderToken;
    const ws = cfg.lark.workspaceUrl.replace(/\/+$/, ""); // tolerate a trailing slash even though config strips it

    return {
      folderUrl: `${ws}/drive/folder/${token}`,
      fileUrl: row.remoteId ? `${ws}/file/${row.remoteId}` : undefined,
    };
  }
  return {}; // local: browser can't open a local dir; the file link is built by the frontend
}
