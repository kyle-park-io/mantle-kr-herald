import type { UploadRequest, UploadResult } from "../domain/publish/publishModels";

export interface DriveUploader {
  /** Upload one file to this drive's folder for req.folder. */
  upload(req: UploadRequest): Promise<UploadResult>;
  /**
   * Replace an already-uploaded file's content, leaving no duplicate behind. The identity named by
   * `remoteId` is not guaranteed to survive the call — Google and `local` keep it stable, but a
   * target may mint a new id and retire the old one (Lark does, deleting the old `file_token`).
   * Callers must treat the returned `UploadResult.id` as the file's current identity and never
   * reuse the `remoteId` they passed in.
   * Optional: a drive that cannot replace content in place omits this, and the caller reports the
   * item rather than creating a duplicate.
   */
  update?(remoteId: string, req: UploadRequest): Promise<UploadResult>;
  /** Delete an uploaded file by its remoteId. Throws on failure. Optional: an uploader that cannot
   *  delete omits it, and the caller leaves the file (with a warning) rather than failing. */
  delete?(remoteId: string): Promise<void>;
  /** Stable name for idempotency keys + reporting, e.g. `google`, `lark`, `local`. */
  readonly name: string;
}
