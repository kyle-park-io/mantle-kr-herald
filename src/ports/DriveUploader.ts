import type { UploadRequest, UploadResult } from "../domain/publish/publishModels";

export interface DriveUploader {
  /** Upload one file to this drive's folder for req.folder. */
  upload(req: UploadRequest): Promise<UploadResult>;
  /** Stable name for idempotency keys + reporting ("google" | "lark"). */
  readonly name: string;
}
