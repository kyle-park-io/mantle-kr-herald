// tests/cli/systemdShow.test.ts
//
// The one thing `tests/status/translateFloor.test.ts` cannot cover: the real subprocess. `pnpm
// status` is a read-only diagnostic that also runs as a stage inside every watch tick, so this call
// has exactly one hard requirement — whatever the machine does, it returns and never throws. It has
// to hold on a machine with systemd, on one without it (CI), and on one where `systemctl` exists but
// refuses to answer.
import { describe, it, expect } from "vitest";
import { realSystemdShow } from "../../src/cli/systemdShow";
import { translateFloorStatus } from "../../src/status/translateFloor";

describe("realSystemdShow", () => {
  it("returns text or undefined without throwing, whatever this machine has", () => {
    const show = realSystemdShow();
    expect(show === undefined || typeof show === "string").toBe(true);
  });

  it("feeds `translateFloorStatus` something it can classify on any machine", () => {
    // Not asserting *which* state: this suite runs on Kyle's WSL2 box (unit loaded), in a container
    // (no systemctl), and on whatever CI becomes. Asserting the floor here would pin the test to one
    // machine. What must hold everywhere is that the pair produces a state rather than an exception.
    const status = translateFloorStatus({ unitShow: realSystemdShow(), shellValue: process.env.HERALD_TRANSLATE_SINCE });
    expect(["configured", "none", "not-installed", "unreadable", "invalid"]).toContain(status.kind);
  });
});
