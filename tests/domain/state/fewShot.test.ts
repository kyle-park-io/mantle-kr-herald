import { describe, it, expect } from "vitest";
import { FEW_SHOT_REL, fewShotScopeFor } from "../../../src/domain/state/fewShot";
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
