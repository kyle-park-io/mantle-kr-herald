// tests/cli/collectMaxPages.test.ts
//
// `HERALD_COLLECT_MAX_PAGES` is read at the CLI, not in the gateway's constructor, and this file is
// where that read is tested. The split matters: the variable exists for one procedure (a hand-run
// backfill after a coverage GAP), and a constructor reading `process.env` handed the override to
// every command that builds a `TwitterApiSourceGateway` — including four with nothing to do with
// the remedy. See `src/cli/collectMaxPages.ts`'s own doc comment.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseCollectMaxPages,
  refuseCollectMaxPagesOverride,
  COLLECT_MAX_PAGES_ENV,
} from "../../src/cli/collectMaxPages";
import { DEFAULT_MAX_PAGES } from "../../src/adapters/twitterapi/TwitterApiSourceGateway";

describe("parseCollectMaxPages", () => {
  it("defaults to the gateway's own cap when the variable is unset", () => {
    // Not a copy of 50: the whole point of importing the constant is that a scheduled collect and
    // an un-overridden hand run get the same number the gateway would have used on its own.
    expect(DEFAULT_MAX_PAGES).toBe(50);
    expect(parseCollectMaxPages(undefined)).toBe(DEFAULT_MAX_PAGES);
  });

  it("treats an empty or whitespace-only value as unset", () => {
    // `HERALD_COLLECT_MAX_PAGES=` with nothing after it reaches Node as "", not undefined.
    // `Number("")` is 0, which would cap a backfill at zero pages and collect nothing at all.
    expect(parseCollectMaxPages("")).toBe(DEFAULT_MAX_PAGES);
    expect(parseCollectMaxPages("   ")).toBe(DEFAULT_MAX_PAGES);
  });

  it("accepts a raised cap, trimmed — the reason it exists", () => {
    expect(parseCollectMaxPages("200")).toBe(200);
    expect(parseCollectMaxPages(" 500 ")).toBe(500);
  });

  it("refuses values that would silently collect the wrong amount", () => {
    // Same rule as HERALD_WATCH_BATCH (`parsePositiveIntEnv`): a digit pattern plus a positivity
    // and safe-integer check, not `Number()`. A backfill is run once, under incident pressure, and
    // a cap nobody chose is indistinguishable from a cap that worked.
    for (const raw of ["0", "-3", "2.5", "0x10", "1e2", "Infinity", "+3", "many"]) {
      expect(() => parseCollectMaxPages(raw), raw).toThrow(new RegExp(COLLECT_MAX_PAGES_ENV));
    }
  });

  it("names the offending value", () => {
    expect(() => parseCollectMaxPages("lots")).toThrow(/"lots"/);
  });
});

describe("refuseCollectMaxPagesOverride", () => {
  it("lets a tick run when the variable is unset", () => {
    expect(() => refuseCollectMaxPagesOverride(undefined)).not.toThrow();
  });

  it("lets a tick run on a blank value, because .env.example ships the line blank", () => {
    // This is load-bearing, not tidiness: installs are made by copying `.env.example`, which
    // carries `HERALD_COLLECT_MAX_PAGES=`. Refusing "" would fail every tick on a by-the-book
    // install — a guard against silent loss that instead causes a total outage.
    expect(() => refuseCollectMaxPagesOverride("")).not.toThrow();
    expect(() => refuseCollectMaxPagesOverride("   ")).not.toThrow();
  });

  it("refuses any real value, including a valid one", () => {
    // A *valid* value is the dangerous case, and the reason this is a refusal rather than more
    // validation: `HERALD_COLLECT_MAX_PAGES=5` parses fine, truncates every scheduled collect,
    // GAP-fails every tick, and loses the older tail each time. There is no correct value for a
    // tick to carry, so the check is presence, not range.
    expect(() => refuseCollectMaxPagesOverride("5")).toThrow(new RegExp(COLLECT_MAX_PAGES_ENV));
    expect(() => refuseCollectMaxPagesOverride("200")).toThrow(new RegExp(COLLECT_MAX_PAGES_ENV));
    expect(() => refuseCollectMaxPagesOverride("nonsense")).toThrow(new RegExp(COLLECT_MAX_PAGES_ENV));
  });

  it("says what to do instead, since this message reaches Telegram as a tick failure", () => {
    // registerErrorHandler turns this throw into the non-zero exit herald-watch.service's
    // OnFailure= hook watches for, so the text is an alert, not just a console line.
    expect(() => refuseCollectMaxPagesOverride("5")).toThrow(/"5"/);
    expect(() => refuseCollectMaxPagesOverride("5")).toThrow(/must never override/);
    expect(() => refuseCollectMaxPagesOverride("5")).toThrow(/team-runbook\.md/);
  });

  it("is what makes the unit files' own claim true", () => {
    // deploy/herald-watch.service must not set this variable. The refusal above is the enforcement;
    // this is the guard on the file, so a later well-meaning `Environment=` line fails here rather
    // than at 00:17 on install night.
    const unit = readFileSync(resolve(__dirname, "../../deploy/herald-watch.service"), "utf8");
    expect(unit).not.toMatch(new RegExp(`^Environment=${COLLECT_MAX_PAGES_ENV}=`, "m"));
  });
});

describe("HERALD_COLLECT_MAX_PAGES documentation", () => {
  it("is listed in .env.example, where every read variable is listed", () => {
    const example = readFileSync(resolve(__dirname, "../../.env.example"), "utf8");
    expect(example).toMatch(/^HERALD_COLLECT_MAX_PAGES=/m);
  });
});
