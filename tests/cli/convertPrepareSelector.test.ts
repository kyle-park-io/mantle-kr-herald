// tests/cli/convertPrepareSelector.test.ts
//
// `pnpm convert:prepare`'s command line, read away from the CLI file so that it can be tested at
// all: that script opens a database connection at import time, so the parsing that used to sit
// inline at its top level was unreachable from any test.
//
// `--max-variants` is the flag that made this worth extracting. It is one half of a contract between
// two processes — `src/app/ConvertTick.ts` passes it on every scheduled fire — and if this half
// ignored it, the ceiling would silently never apply: the tick would keep preparing seven pairs,
// keep hitting the agent's ten-minute cap, and both halves would keep passing their own tests.
import { describe, it, expect } from "vitest";
import { conversionSelectorFrom } from "../../src/cli/convertPrepareSelector";
import { MAX_VARIANTS_PER_TICK } from "../../src/app/ConvertTick";
import { ALL_TYPES } from "../../src/domain/conversion/models";

describe("conversionSelectorFrom", () => {
  it("reads the pair ceiling the conversion tick passes, alongside the item limit", () => {
    // Spelled as the tick spells it, constant included, so a rename on either side fails here.
    const args = ["--limit", "1", "--max-variants", String(MAX_VARIANTS_PER_TICK)];
    expect(conversionSelectorFrom(args)).toEqual({ limit: 1, maxVariants: MAX_VARIANTS_PER_TICK });
  });

  it("leaves the ceiling unset when nothing asks for one", () => {
    // A hand-run `pnpm convert:prepare` and the dashboard's [변환 준비] button both prepare every
    // pair they selected; only the scheduler is working against a clock. An empty selector is what
    // `PrepareConversions` reads as "no ceiling", so this is the difference between the two callers.
    expect(conversionSelectorFrom([])).toEqual({});
    expect(conversionSelectorFrom(["--limit", "3"])).toEqual({ limit: 3 });
  });

  it("still reads every selector flag the command already had", () => {
    const args = ["--ids", "x:1, x:2", "--since", "2026-08-01", "--limit", "2", "--types", "x,pr"];
    expect(conversionSelectorFrom(args)).toEqual({
      ids: ["x:1", "x:2"],
      since: "2026-08-01",
      limit: 2,
      types: ["x", "pr"],
    });
  });

  it("refuses a type that is not a conversion type, naming it and the allowed set", () => {
    // The CLI threw on this before the extraction, and it has to keep throwing: `--types kakao`
    // (for `kakao_notice`) silently selecting nothing would look exactly like "nothing is waiting".
    expect(() => conversionSelectorFrom(["--types", "x,kakao"])).toThrow(/kakao/);
    expect(() => conversionSelectorFrom(["--types", "kakao"])).toThrow(new RegExp(ALL_TYPES.join(", ")));
  });

  it("ignores a numeric flag whose value is not a number, exactly as it did inline", () => {
    // Characterisation, not endorsement: `--limit abc` has always fallen back to the use case's own
    // default rather than failing, and the extraction is not the change that gets to revisit that.
    expect(conversionSelectorFrom(["--limit", "abc"])).toEqual({});
    expect(conversionSelectorFrom(["--max-variants", "abc"])).toEqual({});
  });
});
