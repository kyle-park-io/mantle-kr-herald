import type { StateFile } from "../domain/state/snapshot";

/**
 * The four non-regenerable operational files, as a snapshot source and a restore target.
 *
 * Structurally identical to `ConfigFileStore` and deliberately not an alias of it. The two answer
 * different questions: `ConfigFileStore` globs whatever is in `translation/` and `conversion/`,
 * while this one tracks a fixed, named manifest — `tracked()` exists only here, and exists so a
 * pull can refuse a snapshot entry it does not recognise before it writes anything.
 */
export interface StateFileStore {
  /** The tracked files that exist right now. A file that has never been written is simply absent —
   *  a fresh machine lists nothing, which is the ordinary state before the first send. */
  list(): Promise<StateFile[]>;
  /** Write one tracked file by its repo-relative path. Rejects a path outside the manifest. */
  write(path: string, content: string): Promise<void>;
  /** Copy everything `list()` returns under `destDir`, preserving relative paths. */
  backup(destDir: string): Promise<void>;
  /** Every repo-relative path this store tracks, present or not. */
  tracked(): readonly string[];
}
