import type { UploadRequest, UploadResult } from "../domain/publish/publishModels";

export interface DriveUploader {
  /** Upload one file to this drive's folder for req.folder. */
  upload(req: UploadRequest): Promise<UploadResult>;
  /**
   * Replace the content of an already-uploaded file, keeping its remote id and share link.
   * Optional: a drive that cannot replace content in place simply omits this, and the caller
   * reports the item rather than creating a duplicate.
   */
  update?(remoteId: string, req: UploadRequest): Promise<UploadResult>;
  /** Stable name for idempotency keys + reporting ("google" | "lark"). */
  readonly name: string;
}
