import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleDriveUploader } from "../adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../adapters/drive/LarkDriveUploader";
import { LocalFileUploader } from "../adapters/drive/LocalFileUploader";
import { renderSent, sentFileName } from "../domain/publish/renderers";
import { loadGoogleAuthConfig, loadGoogleDriveConfig, loadLarkDriveConfig, loadStorageMode } from "../config";
import type { Archiver } from "../app/SendChannels";
import type { DriveUploader } from "../ports/DriveUploader";
import type { StorageMode } from "../storage/mode";
import { paths } from "../paths";

/** Which drives receive the sent-rendering archive: local mode → the filesystem; cloud mode → each
 *  drive that has a sent folder configured. Pure so the mode/config matrix is unit-testable. */
export function sentArchiveTargets(
  mode: StorageMode,
  configured: { google: boolean; lark: boolean },
): ("local" | "google" | "lark")[] {
  if (mode === "local") return ["local"];
  const targets: ("google" | "lark")[] = [];
  if (configured.google) targets.push("google");
  if (configured.lark) targets.push("lark");
  return targets;
}

function tryLoad<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Best-effort sent-rendering archiver: undefined unless at least one target is available, so a send
 *  works with no archive configured. Symmetric with buildRecorder (§9b). */
export async function buildArchiver(): Promise<Archiver | undefined> {
  const mode = loadStorageMode();
  const g = tryLoad(loadGoogleDriveConfig);
  const l = tryLoad(loadLarkDriveConfig);
  const targets = sentArchiveTargets(mode, { google: !!g?.sentFolderId, lark: !!l?.sentFolderToken });
  if (targets.length === 0) return undefined;

  const uploaders: DriveUploader[] = [];
  for (const t of targets) {
    try {
      if (t === "local") {
        uploaders.push(new LocalFileUploader(paths.publishLocalDir));
      } else if (t === "google") {
        uploaders.push(new GoogleDriveUploader(await createGoogleAuth(loadGoogleAuthConfig()), { sent: g!.sentFolderId }));
      } else {
        uploaders.push(new LarkDriveUploader(new LarkAuth(new HttpClient(l!.baseUrl), l!.appId, l!.appSecret), l!.baseUrl, { sent: l!.sentFolderToken }));
      }
    } catch (err) {
      console.warn(`[archive] could not initialize ${t} archiver: ${(err as Error).message} — skipping`);
    }
  }
  if (uploaders.length === 0) return undefined;

  return async (entry) => {
    const name = sentFileName(entry);
    const content = renderSent(entry);
    for (const u of uploaders) {
      try {
        await u.upload({ name, content, folder: "sent" });
      } catch (err) {
        console.warn(`[archive] ${entry.itemId}/${entry.channel} → ${u.name} failed: ${(err as Error).message}`);
      }
    }
  };
}
