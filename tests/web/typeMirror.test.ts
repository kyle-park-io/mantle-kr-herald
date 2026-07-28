import { describe, expect, it } from "vitest";
import { ALL_TYPES, typeLabel } from "../../src/domain/conversion/models";
import { ALL_CHANNELS } from "../../src/domain/formatting/models";
import { DESTINATIONS_BY_CHANNEL } from "../../src/domain/formatting/emitters";
import { ALL_OUTLETS } from "../../src/domain/outlet/models";
import type { BoardView, BoardGroup, BoardRow } from "../../src/adapters/web/board";
import type { FormatWarning } from "../../src/app/FormatVariants";
import {
  ALL_TYPES as WEB_TYPES,
  ALL_CHANNELS as WEB_CHANNELS,
  TYPE_LABEL as WEB_TYPE_LABEL,
  OUTLET_LABEL as WEB_OUTLET_LABEL,
  OUTLET_DELIVERY as WEB_OUTLET_DELIVERY,
  PASTE_DESTINATION as WEB_PASTE_DESTINATION,
  type BoardView as WebBoardView,
  type BoardGroup as WebBoardGroup,
  type BoardRow as WebBoardRow,
  type FormatWarning as WebFormatWarning,
} from "../../web/src/types";

/**
 * The dashboard cannot import the domain — `web/tsconfig.json` includes only `web/src` and Vite's
 * root is `web/`, so the frontend keeps a hand-written copy of the conversion vocabulary. Nothing
 * in either typecheck compares the two: adding a ConversionType passes `tsc` on both sides while
 * the dashboard silently loses the new type from its filter. (That is exactly what happened when
 * `explainer` and `casual` landed.) These tests are the only thing that catches it.
 */
/** `true` when A and B carry exactly the same keys; otherwise a tuple naming the ones that drifted. */
type Drift<A, B> = Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>;
type SameKeys<A, B> = [Drift<A, B>] extends [never] ? true : ["board mirror drifted on", Drift<A, B>];

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

  /**
   * The board *payload* mirror, checked by `tsc` rather than at runtime.
   *
   * Nothing else catches drift here. Renaming `deliveryStatus` to `state` in `board.ts` (and in
   * its own tests) leaves every typecheck and all 900-odd tests green while the dashboard reads
   * `undefined` for it — so an already-`sent` room paints `[발송]` again and the reviewer confirms
   * a duplicate live post. The checks live in a test file because the root tsconfig includes
   * `tests`, which is what lets one file import both sides.
   *
   * Two checks, because either alone has a hole:
   *
   * - **assignability, both ways** catches a *type* change (`status: string`) and a required field
   *   going missing, but not a renamed *optional* field — an extra property is legal on a
   *   non-fresh object type, and an absent optional one is legal too, so `deliveryStatus` → `state`
   *   passes it in both directions.
   * - **`SameKeys`** closes exactly that hole by comparing the key sets, and fails with a message
   *   naming the keys that drifted.
   */
  it("mirrors the board payload field-for-field, in both directions", () => {
    const rowFromDomain: WebBoardRow = {} as BoardRow;
    const rowToDomain: BoardRow = {} as WebBoardRow;
    const groupFromDomain: WebBoardGroup = {} as BoardGroup;
    const groupToDomain: BoardGroup = {} as WebBoardGroup;
    const viewFromDomain: WebBoardView = {} as BoardView;
    const viewToDomain: BoardView = {} as WebBoardView;
    const rowKeys: SameKeys<WebBoardRow, BoardRow> = true;
    const groupKeys: SameKeys<WebBoardGroup, BoardGroup> = true;
    const viewKeys: SameKeys<WebBoardView, BoardView> = true;
    // The assertion is the compile above; this only keeps the bindings live.
    expect([rowFromDomain, rowToDomain, groupFromDomain, groupToDomain, viewFromDomain, viewToDomain]).toHaveLength(6);
    expect([rowKeys, groupKeys, viewKeys]).toEqual([true, true, true]);
  });

  /**
   * `POST /api/items/:id/format`'s response mirror. A silent drift here would show a reviewer
   * fewer/renamed warning fields than the server actually computed — the same blind spot the board
   * payload check above exists for, just for §10's route instead of §8's.
   */
  it("mirrors FormatWarning field-for-field, in both directions", () => {
    const fromDomain: WebFormatWarning = {} as FormatWarning;
    const toDomain: FormatWarning = {} as WebFormatWarning;
    const keys: SameKeys<WebFormatWarning, FormatWarning> = true;
    expect([fromDomain, toDomain]).toHaveLength(2);
    expect(keys).toBe(true);
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
