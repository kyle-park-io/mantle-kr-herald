import { describe, expect, it } from "vitest";
import { ALL_TYPES, typeLabel } from "../../src/domain/conversion/models";
import { ALL_CHANNELS } from "../../src/domain/formatting/models";
import {
  ALL_TYPES as WEB_TYPES,
  ALL_CHANNELS as WEB_CHANNELS,
  TYPE_LABEL as WEB_TYPE_LABEL,
} from "../../web/src/types";

/**
 * The dashboard cannot import the domain — `web/tsconfig.json` includes only `web/src` and Vite's
 * root is `web/`, so the frontend keeps a hand-written copy of the conversion vocabulary. Nothing
 * in either typecheck compares the two: adding a ConversionType passes `tsc` on both sides while
 * the dashboard silently loses the new type from its filter. (That is exactly what happened when
 * `explainer` and `casual` landed.) These tests are the only thing that catches it.
 */
describe("web type mirror", () => {
  it("mirrors ALL_TYPES from the domain, in the same order", () => {
    expect([...WEB_TYPES]).toEqual(ALL_TYPES);
  });

  it("mirrors ALL_CHANNELS from the domain, in the same order", () => {
    expect([...WEB_CHANNELS]).toEqual(ALL_CHANNELS);
  });

  it("labels every type exactly as the domain does", () => {
    for (const type of ALL_TYPES) {
      expect(WEB_TYPE_LABEL[type], `label for ${type}`).toBe(typeLabel(type));
    }
  });
});
