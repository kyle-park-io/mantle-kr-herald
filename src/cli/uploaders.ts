import { parseList } from "./args";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleDriveUploader } from "../adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../adapters/drive/LarkDriveUploader";
import { LocalFileUploader } from "../adapters/drive/LocalFileUploader";
import { loadGoogleAuthConfig, loadGoogleDriveConfig, loadLarkDriveConfig } from "../config";
import type { DriveUploader } from "../ports/DriveUploader";
import type { StorageMode } from "../storage/mode";
import { paths } from "../paths";

export const ALL_TARGETS = ["google", "lark", "local"] as const;
export type PublishTarget = (typeof ALL_TARGETS)[number];

/** Usage/error text is interpolated from ALL_TARGETS: a hardcoded list goes stale invisibly. */
export const TARGETS_USAGE = ALL_TARGETS.join("|");

const CLOUD_TARGETS: readonly PublishTarget[] = ["google", "lark"];

function isTarget(value: string): value is PublishTarget {
  return (ALL_TARGETS as readonly string[]).includes(value);
}

/** local mode publishes to disk; cloud mode keeps Google as the historical default. */
export function defaultTarget(mode: StorageMode): PublishTarget {
  return mode === "local" ? "local" : "google";
}

/**
 * Expand `--target`. `both` predates the third target and is kept as an alias so existing usage
 * does not break. A cloud target in local mode throws rather than skipping: the credentials are
 * absent so it would fail anyway, and hiding that behind exit 0 is the failure this whole change
 * corrects.
 */
export function resolveTargets(raw: string | undefined, mode: StorageMode): PublishTarget[] {
  const requested = parseList(raw) ?? [defaultTarget(mode)];
  const expanded = requested.flatMap((t) => (t === "both" ? ["google", "lark"] : [t]));

  const resolved: PublishTarget[] = [];
  for (const candidate of expanded) {
    if (!isTarget(candidate)) {
      throw new Error(`Unknown publish target: ${candidate} (expected ${TARGETS_USAGE}, or "both" for google,lark)`);
    }
    if (mode === "local" && CLOUD_TARGETS.includes(candidate)) {
      throw new Error(
        `--target ${candidate} needs HERALD_STORAGE_MODE=cloud (currently local). ` +
          `Use --target local to publish to ${paths.publishLocalDir}.`,
      );
    }
    if (!resolved.includes(candidate)) resolved.push(candidate);
  }
  return resolved;
}

/** The one place uploaders are constructed — shared by `drive:publish` and the dashboard. */
export async function createUploaders(targets: PublishTarget[]): Promise<DriveUploader[]> {
  const uploaders: DriveUploader[] = [];
  for (const target of targets) {
    if (target === "google") {
      const g = loadGoogleDriveConfig();
      const auth = await createGoogleAuth(loadGoogleAuthConfig());
      uploaders.push(new GoogleDriveUploader(auth, { review: g.reviewFolderId, approved: g.approvedFolderId }));
    } else if (target === "lark") {
      const l = loadLarkDriveConfig();
      const auth = new LarkAuth(new HttpClient(l.baseUrl), l.appId, l.appSecret);
      uploaders.push(
        new LarkDriveUploader(auth, l.baseUrl, { review: l.reviewFolderToken, approved: l.approvedFolderToken }),
      );
    } else {
      uploaders.push(new LocalFileUploader(paths.publishLocalDir));
    }
  }
  return uploaders;
}
