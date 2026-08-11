import { spawnSync } from "node:child_process";
import { WATCH_UNIT, type SystemdShow } from "../status/translateFloor";

/** Long enough that a busy user manager still answers, short enough that `pnpm status` — which runs
 *  as a stage inside every watch tick — cannot be held up by one. */
const TIMEOUT_MS = 3_000;

/**
 * The real `SystemdShow` `status.ts` hands to `translateFloorStatus`: the loaded unit's environment,
 * asked of the *manager* rather than read out of `deploy/herald-watch.service`.
 *
 * Why the manager. A unit file edited without `systemctl --user daemon-reload` is not what runs —
 * the manager keeps the values from the last reload, and the next tick uses those. Reading the file
 * would report what someone meant; this reports what the timer will actually fire with.
 *
 * Why `LoadState` comes along. `systemctl show` exits 0 for a unit it has never heard of and prints
 * a bare `Environment=` for it, which is byte-identical to a loaded unit that sets no variables at
 * all. Without `LoadState` the two states — "no scheduler on this machine" and "a scheduler with no
 * floor, draining the whole backlog oldest-first" — are indistinguishable, and one of them is an
 * alarm. Both properties are asked for in one call so they cannot describe two different moments.
 *
 * Nothing here throws, and that is load-bearing: `pnpm status` is a read-only diagnostic that must
 * still print its pipeline table on a machine with no systemd (CI, a container, macOS), and it is
 * also a stage inside every watch tick — a throw here would fail ticks over a diagnostic. Every
 * failure mode collapses to `undefined`, which `translateFloorStatus` reports as "cannot determine"
 * rather than as "no floor". `spawnSync` reports a missing binary and a timeout as `error` rather
 * than by throwing; the try/catch covers what is left (an argv `spawnSync` itself rejects).
 */
export const realSystemdShow: SystemdShow = () => showWatchUnit("Environment", "LoadState");

/**
 * The same call, asking which directory the scheduler runs *out of* — `pnpm doctor`'s deploy-drift
 * check (`src/doctor/deploySteering.ts`), which needs to find the other checkout on this machine
 * without any path being written down in `src/`.
 *
 * A separate export rather than two more properties on the one above, because the two questions have
 * different readers and different costs: `realSystemdShow` runs inside every watch tick (via `pnpm
 * status`), and widening its query would make every tick pay for a property nothing there reads.
 * `LoadState` rides along here for the same reason it does above — a unit systemd has never heard of
 * answers `WorkingDirectory=` exactly like a loaded unit that sets none, and the first is "no
 * scheduler on this machine" while the second is a misconfigured one.
 */
export const realDeployTreeShow: SystemdShow = () => showWatchUnit("WorkingDirectory", "LoadState");

/** Both exports' single implementation — see `realSystemdShow` above for why nothing here throws. */
function showWatchUnit(...properties: string[]): string | undefined {
  try {
    const result = spawnSync(
      "systemctl",
      ["--user", "show", WATCH_UNIT, ...properties.map((p) => `--property=${p}`)],
      { encoding: "utf8", timeout: TIMEOUT_MS },
    );
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}
