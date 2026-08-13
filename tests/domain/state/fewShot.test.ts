import { describe, it, expect } from "vitest";
import { FEW_SHOT_REL, fewShotScopeFor, assertRestorableFewShot } from "../../../src/domain/state/fewShot";
import { ALL_TYPES } from "../../../src/domain/conversion/models";

describe("FEW_SHOT_REL", () => {
  it("names one path per corpus — translation plus every conversion type", () => {
    expect(FEW_SHOT_REL).toHaveLength(ALL_TYPES.length + 1);
    expect(FEW_SHOT_REL[0]).toBe("output/few-shot/translation.json");
    for (const type of ALL_TYPES) {
      expect(FEW_SHOT_REL).toContain(`output/few-shot/conversion.${type}.json`);
    }
  });

  it("does not reuse the db:export names, which mean a different artifact", () => {
    // `translation/few-shot.json` and `conversion/few-shot.<type>.json` are what `db:export` writes
    // for the db:export → db:import rollback path. They live in the steering directories and both
    // `config:push` and `deploy:freeze` deliberately exclude them. Colliding the two on one string
    // is the confusion this naming exists to avoid.
    for (const rel of FEW_SHOT_REL) {
      expect(rel.startsWith("output/few-shot/")).toBe(true);
    }
  });
});

describe("fewShotScopeFor", () => {
  it("maps every tracked path back to its store scope", () => {
    expect(fewShotScopeFor("output/few-shot/translation.json")).toBe("translation");
    for (const type of ALL_TYPES) {
      expect(fewShotScopeFor(`output/few-shot/conversion.${type}.json`)).toBe(`conversion:${type}`);
    }
  });

  it("returns undefined for anything else, so write() falls through to its own refusal", () => {
    expect(fewShotScopeFor("output/publish/deliveries.json")).toBeUndefined();
    expect(fewShotScopeFor("output/few-shot/conversion.nosuchtype.json")).toBeUndefined();
    expect(fewShotScopeFor("output/few-shot/../../etc/passwd")).toBeUndefined();
  });
});

describe("assertRestorableFewShot", () => {
  it("accepts examples that all carry an itemId", () => {
    expect(() =>
      assertRestorableFewShot([{ source: "a", target: "가", itemId: "x:1" }], "translation"),
    ).not.toThrow();
  });

  it("accepts an empty corpus", () => {
    expect(() => assertRestorableFewShot([], "translation")).not.toThrow();
  });

  it("refuses a corpus holding an itemId-less example, naming the scope and the count", () => {
    // `PgFewShotStore.add` is `insert ... on conflict (scope, item_id) do update`, and Postgres never
    // considers one null item_id equal to another. An itemId-less row is therefore unreachable by
    // that key: it can never be replaced or deduplicated, and a re-approval of the same example lands
    // beside it. The corpus is already drifting, and the push is where that gets said out loud.
    expect(() =>
      assertRestorableFewShot(
        [
          { source: "a", target: "가", itemId: "x:1" },
          { source: "b", target: "나" },
        ],
        "conversion:x",
      ),
    ).toThrow(/conversion:x/);
  });

  it("tells the operator the restore path is not blocked by this", () => {
    // The message's own history. It used to end "Refusing to push a snapshot that cannot be restored
    // twice — give those rows an item_id and push again", and because the assertion fired from inside
    // `snapshotFromDb` it reached operators running `pnpm state:pull` — a read-only preview, no push
    // in sight, advice they could not act on, and the restore blocked at the moment it was most
    // needed. The gate is push-only now; the message says so rather than leaving it to be discovered.
    let message = "";
    try {
      assertRestorableFewShot([{ source: "b", target: "나" }], "translation");
    } catch (err: unknown) {
      message = (err as Error).message;
    }
    expect(message).toContain("state:pull");
    expect(message).not.toContain("restored twice");
  });
});
