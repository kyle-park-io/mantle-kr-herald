import { describe, it, expect } from "vitest";
import { isFewShotExport, isExampleFile, isSteeringConfigFile } from "../../../src/domain/config/steering";
import { ALL_TYPES } from "../../../src/domain/conversion/models";

describe("isFewShotExport", () => {
  it("matches the file db:export writes for the translation scope", () => {
    expect(isFewShotExport("few-shot.json")).toBe(true);
  });

  it("matches the file db:export writes for every conversion type", () => {
    // Derived from ALL_TYPES rather than a literal list, so a new conversion type cannot be added
    // with an export artifact this predicate silently treats as configuration.
    for (const type of ALL_TYPES) expect(isFewShotExport(`few-shot.${type}.json`), type).toBe(true);
  });

  it("does NOT match tm.json", () => {
    // The trap this predicate is written around: tm.json is a FewShotStore in the code too, but
    // `translate:prepare` and `translate:align` genuinely read it, so it must keep syncing.
    expect(isFewShotExport("tm.json")).toBe(false);
  });

  it("does not match the hand-curated steering files", () => {
    for (const name of ["glossary.json", "locale.json", "style-guide.md", "x.md", "checklist.x.md"]) {
      expect(isFewShotExport(name), name).toBe(false);
    }
  });
});

describe("isSteeringConfigFile", () => {
  it("accepts the configuration a fresh checkout must be handed", () => {
    for (const name of ["glossary.json", "style-guide.md", "locale.json", "tm.json", "x.md", "checklist.announcement.md"]) {
      expect(isSteeringConfigFile(name), name).toBe(true);
    }
  });

  it("rejects the committed skeletons and the db:export artifacts alike", () => {
    for (const name of ["glossary.example.json", "few-shot.json", "few-shot.x.json", "few-shot.example.json"]) {
      expect(isSteeringConfigFile(name), name).toBe(false);
    }
  });

  it("agrees with isExampleFile on the skeletons", () => {
    expect(isExampleFile("tm.example.json")).toBe(true);
    expect(isExampleFile("tm.json")).toBe(false);
  });
});
