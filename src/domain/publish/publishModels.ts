export type FolderKind = "review" | "approved";

export interface UploadRequest {
  name: string;
  content: string;
  folder: FolderKind;
}

export interface UploadResult {
  id: string;
  name: string;
  /** Viewer link, when the drive returns one (Google does; Lark's upload response does not). */
  url?: string;
}
