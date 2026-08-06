import { describe, it, expect } from "vitest";
import { attachKind } from "../../../src/adapters/web/attachKind";
import type { Translation } from "../../../src/domain/translation/models";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

const tr = (itemId: string): Translation =>
  ({ itemId, source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" });
const item = (id: string, kind?: "post" | "article", createdAt = "c"): ContentItem =>
  ({ id, source: "x", text: "x", createdAt, kind });

describe("attachKind", () => {
  it("attaches each source item's kind by itemId", () => {
    const [r] = attachKind([tr("x:1")], [item("x:1", "article")]);
    expect(r.kind).toBe("article");
  });
  it("attaches the source item's post date as sourcePostedAt", () => {
    const [r] = attachKind([tr("x:1")], [item("x:1", "post", "2026-07-24T00:00:00Z")]);
    expect(r.sourcePostedAt).toBe("2026-07-24T00:00:00Z");
  });
  /**
   * The whole reason this field is named `sourcePostedAt` rather than `postedAt`: `Translation` (the
   * domain model) has its own `postedAt` (Task 2's reconcile-match timestamp), a completely different
   * concept. An earlier version of `attachKind` unconditionally overwrote it with the source item's
   * post date, silently discarding whichever translations HAD been reconcile-matched. Pins that this
   * can no longer happen — the two fields have different names now, so there is nothing left to
   * shadow.
   */
  it("does not touch the translation's own postedAt (the reconcile-match timestamp) — nothing shares that name any more", () => {
    const reconciled: Translation = { ...tr("x:1"), postedAt: "2026-08-06T09:00:00.000Z" };
    const [r] = attachKind([reconciled], [item("x:1", "post", "2026-07-24T00:00:00Z")]);
    expect(r.postedAt).toBe("2026-08-06T09:00:00.000Z"); // the domain's own value, passed through
    expect(r.sourcePostedAt).toBe("2026-07-24T00:00:00Z"); // the display value, under its own name
  });
  it("leaves kind undefined when the source item is absent", () => {
    const [r] = attachKind([tr("x:9")], [item("x:1", "post")]);
    expect(r.kind).toBeUndefined();
  });
  it("does not mutate the input translation", () => {
    const input = tr("x:1");
    attachKind([input], [item("x:1", "post")]);
    expect("kind" in input).toBe(false);
  });
});
