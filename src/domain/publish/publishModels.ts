export type FolderKind = "review" | "approved";

export interface UploadRequest {
  name: string;
  content: string;
  folder: FolderKind;
}

export interface UploadResult {
  id: string;
  name: string;
}
