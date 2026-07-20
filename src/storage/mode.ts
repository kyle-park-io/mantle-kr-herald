/** Where approved artifacts are preserved: nowhere but locally, or on Drive. */
export type StorageMode = "local" | "cloud";

const VALID: readonly StorageMode[] = ["local", "cloud"];

/**
 * Never inferred from which credentials happen to be present: silently choosing "local" while
 * the operator believes work is backed up to Drive is the one failure this must not allow.
 */
/**
 * The literal line to paste, not a pointer to another command: `pnpm doctor` is the documented
 * first stop, so telling the reader to run it would be circular when doctor is what printed this.
 * A hint costs nothing against the never-inferred rule — it still refuses to pick for you.
 */
const REMEDY =
  'Add HERALD_STORAGE_MODE=local to .env (or "cloud" if Google/Lark Drive is your record of truth).';

export function parseStorageMode(raw: string | undefined): StorageMode {
  const value = raw?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: HERALD_STORAGE_MODE. ${REMEDY}`);
  }
  if (!VALID.includes(value as StorageMode)) {
    throw new Error(`Invalid HERALD_STORAGE_MODE: ${value} (expected "local" or "cloud"). ${REMEDY}`);
  }
  return value as StorageMode;
}

/**
 * Best-effort mode read for commands that must keep working when the mode is unset or invalid
 * (e.g. `pnpm status`, which is not a cloud command and takes no guard).
 */
export function tryParseStorageMode(raw: string | undefined): StorageMode | undefined {
  try {
    return parseStorageMode(raw);
  } catch {
    return undefined;
  }
}

export function localSkipMessage(command: string): string {
  return `${command}: local mode — skipped (set HERALD_STORAGE_MODE=cloud to enable)`;
}

/** True when `mode` disables cloud writes. The one place that definition lives. */
export function isLocalMode(mode: StorageMode): boolean {
  return mode === "local";
}

/**
 * Throws when `mode` is local, naming `action` in the message. For call sites that cannot use
 * skipIfLocal()'s process.exit(0) — e.g. a live server, where exiting would kill it.
 */
export function assertCloudMode(mode: StorageMode, action: string): void {
  if (isLocalMode(mode)) {
    throw new Error(`local mode — ${action} is disabled (set HERALD_STORAGE_MODE=cloud to enable)`);
  }
}
