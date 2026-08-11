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

  it("carries glossary-dismissed.json, and not its skeleton", () => {
    // The dismissal list `glossary:mine` reads (`JsonGlossaryDismissalStore`) is hand-curated
    // steering config in exactly the sense this module's doc comment defines: read at runtime, never
    // written by the pipeline, and lost forever if this machine dies. It has to ride `config:push`,
    // `config:pull` and `deploy:freeze` with the glossary it belongs to — losing it silently
    // un-dismisses every candidate a human has already said no to, and the symptom is next Monday's
    // digest quietly growing back the lines somebody spent an afternoon rejecting.
    //
    // Pinned explicitly even though `isSteeringConfigFile` accepts it by default, because "accepts
    // everything that isn't an example or a few-shot export" is a rule somebody could narrow to an
    // allow-list later, and this file's membership would then vanish with no test failing.
    expect(isSteeringConfigFile("glossary-dismissed.json")).toBe(true);
    expect(isSteeringConfigFile("glossary-dismissed.example.json")).toBe(false);
    // Not a few-shot export, despite living beside them in `translation/` — the same trap
    // `isFewShotExport` is written around for `tm.json`.
    expect(isFewShotExport("glossary-dismissed.json")).toBe(false);
  });
});
