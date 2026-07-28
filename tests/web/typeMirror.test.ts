import { describe, expect, it } from "vitest";
import { ALL_TYPES, typeLabel } from "../../src/domain/conversion/models";
import { ALL_CHANNELS } from "../../src/domain/formatting/models";
import { DESTINATIONS_BY_CHANNEL } from "../../src/domain/formatting/emitters";
import { ALL_OUTLETS } from "../../src/domain/outlet/models";
import {
  ALL_TYPES as WEB_TYPES,
  ALL_CHANNELS as WEB_CHANNELS,
  TYPE_LABEL as WEB_TYPE_LABEL,
  OUTLET_LABEL as WEB_OUTLET_LABEL,
  OUTLET_DELIVERY as WEB_OUTLET_DELIVERY,
  PASTE_DESTINATION as WEB_PASTE_DESTINATION,
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

  /**
   * The board sends `outletId`s over the wire and the dashboard turns them back into room names,
   * so an unmirrored outlet shows a reviewer a raw `tg-dev` — and `OUTLET_DELIVERY` decides
   * whether a locally added row offers [발송] (a real post) or [전달함]. Both records are keyed
   * `Record<string, …>`, so `tsc` cannot notice either drift; only these tests can.
   */
  it("labels every outlet exactly as the domain does, and no more", () => {
    for (const outlet of ALL_OUTLETS) {
      expect(WEB_OUTLET_LABEL[outlet.id], `label for ${outlet.id}`).toBe(outlet.label);
    }
    expect(Object.keys(WEB_OUTLET_LABEL).sort()).toEqual(ALL_OUTLETS.map((o) => o.id).sort());
  });

  it("mirrors every outlet's delivery mode, and no more", () => {
    for (const outlet of ALL_OUTLETS) {
      expect(WEB_OUTLET_DELIVERY[outlet.id], `delivery for ${outlet.id}`).toBe(outlet.delivery);
    }
    expect(Object.keys(WEB_OUTLET_DELIVERY).sort()).toEqual(ALL_OUTLETS.map((o) => o.id).sort());
  });

  /** [복사] hands a human the `_paste` spelling; the canonical text would paste raw markdown. */
  it("names each channel's paste destination as the domain does", () => {
    for (const channel of ALL_CHANNELS) {
      const paste = DESTINATIONS_BY_CHANNEL[channel].filter((d) => d === "pr_mail" || d.endsWith("_paste"));
      expect(paste, `paste destinations for ${channel}`).toHaveLength(1);
      expect(WEB_PASTE_DESTINATION[channel], `paste destination for ${channel}`).toBe(paste[0]);
    }
  });
});
