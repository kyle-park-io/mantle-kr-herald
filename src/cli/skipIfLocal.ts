import { loadStorageMode } from "../config";
import { isLocalMode, localSkipMessage } from "../storage/mode";

/**
 * Cloud commands are a no-op in local mode. Exits 0, not non-zero: not publishing in local mode
 * is correct behaviour, and a failing exit code would break any wrapper script.
 */
export function skipIfLocal(command: string): void {
  if (isLocalMode(loadStorageMode())) {
    console.log(localSkipMessage(command));
    process.exit(0);
  }
}
