import type { UploadRequest, UploadResult } from "../domain/publish/publishModels";

export interface DriveUploader {
  /** Upload one file to this drive's folder for req.folder. */
  upload(req: UploadRequest): Promise<UploadResult>;
  /**
   * Replace the content of an already-uploaded file in place, preserving whatever stable identity
   * the target uses to address it — a Google file id and its share link, or a local path.
   * Optional: a drive that cannot replace content in place omits this, and the caller reports the
   * item rather than creating a duplicate.
   */
  update?(remoteId: string, req: UploadRequest): Promise<UploadResult>;
  /** Stable name for idempotency keys + reporting, e.g. `google`, `lark`, `local`. */
  readonly name: string;
}
