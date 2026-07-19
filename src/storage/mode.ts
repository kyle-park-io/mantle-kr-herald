/** Where approved artifacts are preserved: nowhere but locally, or on Drive. */
export type StorageMode = "local" | "cloud";

const VALID: readonly StorageMode[] = ["local", "cloud"];

/**
 * Never inferred from which credentials happen to be present: silently choosing "local" while
 * the operator believes work is backed up to Drive is the one failure this must not allow.
 */
export function parseStorageMode(raw: string | undefined): StorageMode {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      'Missing required environment variable: HERALD_STORAGE_MODE (expected "local" or "cloud"). Run pnpm doctor.',
    );
  }
  if (!VALID.includes(value as StorageMode)) {
    throw new Error(`Invalid HERALD_STORAGE_MODE: ${value} (expected "local" or "cloud"). Run pnpm doctor.`);
  }
  return value as StorageMode;
}

export function localSkipMessage(command: string): string {
  return `${command}: local mode — skipped (set HERALD_STORAGE_MODE=cloud to enable)`;
}
