import { assembleConfigBundle, parseConfigBundle, type ConfigFile } from "../config/bundle";

/**
 * One tracked operational file: its repo-relative path and its full text.
 *
 * Structurally the steering bundle's entry, and deliberately the same container format — what
 * differs between the two features is the sharing model, not the JSON. See the design spec's
 * "Why this is not `config:push` with more files".
 */
export type StateFile = ConfigFile;

/** Drive file-name prefix. `latest()` matches on it, so it must not be a prefix of any other bundle. */
export const STATE_SNAPSHOT_PREFIX = "operational-state-";

export function assembleStateSnapshot(files: StateFile[], now: () => string = () => new Date().toISOString()): string {
  return assembleConfigBundle(files, now);
}

export function parseStateSnapshot(json: string): StateFile[] {
  return parseConfigBundle(json, "operational state");
}

/** `operational-state-2026-07-29T00-00-00-000Z.json` — colons and dots are illegal-ish in file names. */
export function snapshotName(stamp: string): string {
  return `${STATE_SNAPSHOT_PREFIX}${stamp.replace(/[:.]/g, "-")}.json`;
}

/**
 * How many records a tracked file holds, or `undefined` when this shape has no obvious row count.
 *
 * The four tracked files are two shapes: a bare array (`overrides.json`, `deliveries.json`,
 * `x-article.json`) and `{ entries: [...] }` (`publish/state.json`, whose pre-outlet form was
 * `{ published: [...] }` and is still read by `JsonPublishStore`). Anything else counts as unknown
 * rather than zero: a dry run that prints `0행` for a file it simply failed to understand would
 * read as "nothing to lose" at exactly the moment the operator is deciding whether to overwrite it.
 *
 * Never throws — this feeds a preview, and a corrupt local file must still be previewable (and,
 * more to the point, still backed up) rather than taking the whole command down.
 */
export function countRows(content: string): number | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (Array.isArray(raw)) return raw.length;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.entries)) return obj.entries.length;
    if (Array.isArray(obj.published)) return obj.published.length;
  }
  return undefined;
}

/**
 * - `overwrite` — in both. The snapshot's rows replace the local ones; this is the row the operator
 *   is actually deciding about.
 * - `restore` — in the snapshot only. Written; there is nothing local to lose. The ordinary case on
 *   a rebuilt machine.
 * - `keep` — local only. **Left untouched.** A pull never deletes: a file absent from the snapshot
 *   usually means it did not exist yet when the snapshot was taken (no X article had been sent, say),
 *   and deleting a live delivery ledger to match an older snapshot is precisely the "reads as
 *   never-sent" incident this whole feature exists to prevent. It is still listed, and loudly,
 *   because keeping it leaves a mixed tree — a ledger restored from three weeks ago sitting beside
 *   one from today — which the operator has to reconcile knowingly.
 */
export type RowChange = "overwrite" | "restore" | "keep";

export interface RowCountDiff {
  path: string;
  /** Rows in the local file; `undefined` when the file is absent locally or its shape is unknown. */
  current?: number;
  /** Rows in the snapshot's copy; `undefined` when absent from the snapshot or shape unknown. */
  incoming?: number;
  change: RowChange;
}

/**
 * The operator's whole decision surface for `state:pull`, as a pure function: what each file holds
 * now, what the snapshot would put there, and whether that is an overwrite. Kept in the domain and
 * out of the CLI precisely because it is the thing being decided — a filename list is not a
 * decision, "128행 → 3행" is.
 *
 * Order is the snapshot's, then any local-only files, so the output is deterministic.
 */
export function diffRowCounts(current: StateFile[], incoming: StateFile[]): RowCountDiff[] {
  const local = new Map(current.map((f) => [f.path, f.content]));
  const out: RowCountDiff[] = incoming.map((f) => {
    const here = local.get(f.path);
    return {
      path: f.path,
      current: here === undefined ? undefined : countRows(here),
      incoming: countRows(f.content),
      change: here === undefined ? ("restore" as const) : ("overwrite" as const),
    };
  });
  const arriving = new Set(incoming.map((f) => f.path));
  for (const f of current) {
    if (arriving.has(f.path)) continue;
    out.push({ path: f.path, current: countRows(f.content), change: "keep" });
  }
  return out;
}

/**
 * Snapshot entries this checkout does not track. A pull aborts on a non-empty result *before* it
 * backs anything up, for two reasons: the path comes from a downloaded file and is about to be
 * joined onto the repo root, and a snapshot naming a file this version has never heard of was
 * written by software this version does not understand — half-restoring an operational-state tree
 * is the mixed-ledger hazard, not a partial success. Aborting is recoverable by upgrading; a
 * half-applied restore of send ledgers is not.
 */
export function unknownStatePaths(incoming: StateFile[], tracked: readonly string[]): string[] {
  const known = new Set(tracked);
  return incoming.map((f) => f.path).filter((p) => !known.has(p));
}
