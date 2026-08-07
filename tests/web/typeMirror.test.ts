import { describe, expect, it } from "vitest";
import { ALL_TYPES, typeLabel } from "../../src/domain/conversion/models";
import { ALL_CHANNELS } from "../../src/domain/formatting/models";
import { CHANNEL_RENDERS_BOLD, DESTINATIONS_BY_CHANNEL } from "../../src/domain/formatting/emitters";
import type { Destination } from "../../src/domain/formatting/emitters/types";
import { ALL_OUTLETS } from "../../src/domain/outlet/models";
import { SEND_BLOCK_REASON, type SendBlock } from "../../src/domain/send/sendBlock";
import { SENDS_CLOSED_MESSAGE } from "../../src/adapters/web/apiHandlers";
import { ALL_DELIVERY_STATUSES, deliveredToRoom } from "../../src/domain/delivery/models";
import { ALL_TRANSLATION_STATUSES } from "../../src/domain/translation/models";
import type { BoardView, BoardGroup, BoardRow } from "../../src/adapters/web/board";
import type { FormatWarning } from "../../src/app/FormatVariants";
import type { FunnelCounts } from "../../src/status/pipeline";
import {
  ALL_TYPES as WEB_TYPES,
  ALL_CHANNELS as WEB_CHANNELS,
  ALL_TRANSLATION_STATUSES as WEB_TRANSLATION_STATUSES,
  TYPE_LABEL as WEB_TYPE_LABEL,
  OUTLET_LABEL as WEB_OUTLET_LABEL,
  OUTLET_DELIVERY as WEB_OUTLET_DELIVERY,
  PASTE_DESTINATION as WEB_PASTE_DESTINATION,
  DESTINATION_LABEL as WEB_DESTINATION_LABEL,
  SEND_BLOCK_REASON as WEB_SEND_BLOCK_REASON,
  SENDS_CLOSED_MESSAGE as WEB_SENDS_CLOSED_MESSAGE,
  CHANNEL_RENDERS_BOLD as WEB_CHANNEL_RENDERS_BOLD,
  CHANNEL_FORMAT_NOTE as WEB_CHANNEL_FORMAT_NOTE,
  deliveredToRoom as WEB_DELIVERED_TO_ROOM,
  type SendBlock as WebSendBlock,
  type Destination as WebDestination,
  type BoardView as WebBoardView,
  type BoardGroup as WebBoardGroup,
  type BoardRow as WebBoardRow,
  type FormatWarning as WebFormatWarning,
  type FunnelCounts as WebFunnelCounts,
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
/** The same check for two string unions rather than two object types. */
type SameUnion<A extends string, B extends string> = [Exclude<A, B> | Exclude<B, A>] extends [never]
  ? true
  : ["mirror drifted on", Exclude<A, B> | Exclude<B, A>];

describe("web type mirror", () => {
  it("mirrors ALL_TYPES from the domain, in the same order", () => {
    expect([...WEB_TYPES]).toEqual(ALL_TYPES);
  });

  it("mirrors ALL_CHANNELS from the domain, in the same order", () => {
    expect([...WEB_CHANNELS]).toEqual(ALL_CHANNELS);
  });

  /**
   * `posted` is the reconcile-retired state (Task 2). Missing it here would leave the dashboard's
   * status filter and `StatusChip` silently stuck on two states while the domain has three — the
   * same class of drift the `explainer`/`casual` incident (this file's own header comment) already
   * produced once for `ALL_TYPES`.
   */
  it("mirrors ALL_TRANSLATION_STATUSES", () => {
    expect([...WEB_TRANSLATION_STATUSES]).toEqual([...ALL_TRANSLATION_STATUSES]);
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

  /**
   * `GET /api/status`'s funnel mirror. This one is written from an actual near-miss: the funnel
   * moved from five bare numbers to a per-stage `{ items, rows }`, and **both typechecks stayed
   * green** — the dashboard kept its own `number` declaration and would have rendered `[object
   * Object]` in the header on the first deploy. `number` vs `StageTally` is exactly the "a *type*
   * change" case the assignability half of the board check above catches, and nothing was pointing
   * it at this payload.
   */
  it("mirrors the status funnel field-for-field, in both directions", () => {
    const fromDomain: WebFunnelCounts = {} as FunnelCounts;
    const toDomain: FunnelCounts = {} as WebFunnelCounts;
    const keys: SameKeys<WebFunnelCounts, FunnelCounts> = true;
    expect([fromDomain, toDomain]).toHaveLength(2);
    expect(keys).toBe(true);
  });

  /**
   * The last unchecked corner of the mirror. `Destination` is a union, not an array, so nothing on
   * the domain side is enumerable at runtime — but every destination is reachable from some
   * channel, which `DESTINATIONS_BY_CHANNEL` does enumerate. Adding one to the domain without
   * mirroring it renders an *unlabelled* tab in 목적지별 출력 — and since `RenderingDetail.tsx` was
   * deleted, that panel is the only place a reviewer ever sees the outgoing bytes.
   *
   * Two checks, for the same reason the board payload has two: `SameUnion` compares the unions at
   * compile time (a destination in neither channel map still cannot drift), and the key-set check
   * proves the dashboard has a Korean label for each one.
   */
  it("mirrors every destination, and labels each of them", () => {
    const unions: SameUnion<WebDestination, Destination> = true;
    const reachable = [...new Set(ALL_CHANNELS.flatMap((c) => DESTINATIONS_BY_CHANNEL[c]))].sort();
    expect(Object.keys(WEB_DESTINATION_LABEL).sort()).toEqual(reachable);
    expect(Object.values(WEB_DESTINATION_LABEL).filter((label) => label.trim() === "")).toEqual([]);
    expect(unions).toBe(true);
  });

  /**
   * The lock the board paints comes from the server's `sendBlock`, so an unmirrored member would
   * render a room with **no reason shown** next to a disabled button — or, if the union drifted the
   * other way, a reason for a state the server can never send. `SEND_BLOCK_REASON` is
   * `Record<SendBlock, string>` on both sides, so `tsc` checks the keys once the unions agree; the
   * runtime check is what proves the two texts actually say the same thing.
   */
  it("mirrors every send block and words each of them identically", () => {
    const unions: SameUnion<WebSendBlock, SendBlock> = true;
    expect(WEB_SEND_BLOCK_REASON).toEqual(SEND_BLOCK_REASON);
    expect(unions).toBe(true);
  });

  /**
   * `EnvironmentBanner`'s persistent notice and `OutletCard`'s locked [발송]/[재발송] tooltip both
   * quote this sentence — an operator who sees it before clicking and one who clicks through and
   * gets it back from the route must read the same words, not two independently-worded refusals for
   * the one state.
   */
  it("says the same thing about closed sends as the route that refuses them", () => {
    expect(WEB_SENDS_CLOSED_MESSAGE).toBe(SENDS_CLOSED_MESSAGE);
  });

  /**
   * The card tells the reviewer whether the `**볼드**` they are typing survives to that channel.
   * Derived here by running the real emitters on a probe rather than restated by hand, because the
   * note is only useful if it cannot quietly stop being true — a card that promises bold on a
   * channel that strips it sends copy whose emphasis silently disappeared.
   */
  it("says bold renders on exactly the channels the domain says it does", () => {
    for (const channel of ALL_CHANNELS) {
      expect(WEB_CHANNEL_RENDERS_BOLD[channel], `bold on ${channel}`).toBe(CHANNEL_RENDERS_BOLD[channel]);
      // Every channel gets a note, and it is about bold — the `**` marker is the one thing a
      // reviewer types that behaves differently per channel. Matching Korean prose any harder than
      // this is a check on wording, not on truth; whether the flag itself is right is settled in
      // `tests/domain/formatting/channelBold.test.ts`, against the real emitters.
      const note = WEB_CHANNEL_FORMAT_NOTE[channel];
      expect(note, `note for ${channel}`).toContain("**");
      expect(note.length, `note for ${channel} is substantive`).toBeGreaterThan(10);
    }
    expect(Object.keys(WEB_CHANNEL_FORMAT_NOTE).sort()).toEqual([...ALL_CHANNELS].sort());
    expect(Object.keys(WEB_CHANNEL_RENDERS_BOLD).sort()).toEqual(Object.keys(CHANNEL_RENDERS_BOLD).sort());
  });

  /**
   * `SameUnion` is the check for *membership*: the web mirror declares its own literal union, and
   * nothing at runtime forces it to match the domain's. Widening `DeliveryEntry["status"]` (Task 2's
   * `dropped`) without widening the mirror would leave the dashboard reading `dropped` rows as
   * `undefined`, painting them as never having gone out rather than as a retired scheduled post.
   * The next test walks `ALL_DELIVERY_STATUSES` to pin what each member *means*; this one pins that
   * the two sides agree on which members exist.
   */
  it("mirrors the delivery status union", () => {
    type Check = SameUnion<NonNullable<BoardRow["deliveryStatus"]>, NonNullable<WebBoardRow["deliveryStatus"]>>;
    const ok: Check = true;
    expect(ok).toBe(true);
  });

  /**
   * The union check above only pins *membership* — it says nothing about what a member means. The
   * domain's `deliveredToRoom` (a denylist: everything counts as delivered except `dropped`, over a
   * `status` that is never undefined on a real ledger row) and the dashboard's own copy (an
   * allowlist: only `sent`/`delivered` count, over a `deliveryStatus` that is also `undefined` for a
   * room nothing has gone out to) are two independent implementations of the same question, on
   * purpose — see the doc comment on the web copy for why the shapes differ. Opposite polarity means
   * nothing forces them to agree on a status neither has seen yet: add a fourth `DeliveryStatus`
   * without deciding whether it counts, and the domain's denylist defaults to "yes" while the web's
   * allowlist defaults to "no" — silently, unless this test walks every member and catches the split.
   */
  it("classifies every delivery status identically on both sides of the boundary", () => {
    for (const status of ALL_DELIVERY_STATUSES) {
      const domainAnswer = deliveredToRoom({ status });
      const webAnswer = WEB_DELIVERED_TO_ROOM({ deliveryStatus: status });
      expect(webAnswer, `deliveryStatus "${status}"`).toBe(domainAnswer);
    }
  });

  /**
   * `droppedAt` is the *other* shape `deliveredToRoom` accepts — how `XArticleSentEntry` retires a
   * row (it carries no `status` field to widen; see the domain function's own docstring). `BoardRow`
   * has no `droppedAt` field to mirror: the board is built from `DeliveryEntry[]` alone
   * (`buildBoard(..., deliveries: DeliveryEntry[])` in `src/adapters/web/board.ts`), and `x-article`
   * — the one outlet that ledger covers — is never rowed on the board at all (`reachable()` in
   * `board.ts` excludes it, since its own send/mark routes would both refuse it). So there is nothing
   * for the web mirror to agree or disagree with here; this pins the domain side alone, on purpose.
   */
  it("excludes a row retired via droppedAt too — a shape the web mirror never receives", () => {
    expect(deliveredToRoom({ status: "sent", droppedAt: "2026-01-01T00:00:00.000Z" })).toBe(false);
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
