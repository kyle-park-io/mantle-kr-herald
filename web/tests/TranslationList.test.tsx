// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TranslationList } from "../src/components/TranslationList";
import type { Translation } from "../src/types";

afterEach(cleanup);

function t(over: Partial<Translation> & { itemId: string }): Translation {
  return {
    source: "x",
    sourceText: "source",
    koreanText: `본문 ${over.itemId}`,
    status: "translated",
    translatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** The visible order, read off the `[YYMMDD]` prefix each row renders. */
function shownIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .filter((s) => s.includes("x:"))
    .map((s) => /x:\d+/.exec(s)?.[0] ?? "");
}

describe("TranslationList order", () => {
  it("puts the newest source post first", () => {
    // The store returns insertion order (`order by ordinal`), which is oldest-first — so the item a
    // reviewer most likely wants sat at the bottom of a scrolling list.
    const { container } = render(
      <TranslationList
        items={[
          t({ itemId: "x:1", sourcePostedAt: "2026-07-28T00:00:00.000Z" }),
          t({ itemId: "x:3", sourcePostedAt: "2026-08-06T00:00:00.000Z" }),
          t({ itemId: "x:2", sourcePostedAt: "2026-08-01T00:00:00.000Z" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(shownIds(container)).toEqual(["x:3", "x:2", "x:1"]);
  });

  it("falls back to translatedAt when a row has no source post date", () => {
    // `sourcePostedAt` is joined from the source item and can be absent — a row missing it must not
    // sort as if it were the oldest thing in the queue.
    const { container } = render(
      <TranslationList
        items={[
          t({ itemId: "x:1", sourcePostedAt: "2026-07-28T00:00:00.000Z" }),
          t({ itemId: "x:2", translatedAt: "2026-08-07T00:00:00.000Z" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(shownIds(container)).toEqual(["x:2", "x:1"]);
  });

  it("orders by id when two posts share a timestamp, so the list never reshuffles between renders", () => {
    const same = "2026-08-01T00:00:00.000Z";
    const { container } = render(
      <TranslationList
        items={[t({ itemId: "x:100", sourcePostedAt: same }), t({ itemId: "x:200", sourcePostedAt: same })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(shownIds(container)).toEqual(["x:200", "x:100"]);
  });

  it("sorts within a filter, not across it", () => {
    const { container } = render(
      <TranslationList
        items={[
          t({ itemId: "x:1", status: "approved", sourcePostedAt: "2026-08-06T00:00:00.000Z" }),
          t({ itemId: "x:2", status: "translated", sourcePostedAt: "2026-08-01T00:00:00.000Z" }),
          t({ itemId: "x:3", status: "translated", sourcePostedAt: "2026-08-05T00:00:00.000Z" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    // Default filter is 전체: all three, newest first.
    expect(shownIds(container)).toEqual(["x:1", "x:3", "x:2"]);
    screen.getByRole("button", { name: /^대기/ }).click();
  });
});

describe("TranslationList filter counts", () => {
  it("counts each filter, so a queue of 2 behind 21 게시됨 is legible without clicking", () => {
    // The shape that misled a reader of `pnpm status`: 23 translations, only 2 of them waiting.
    render(
      <TranslationList
        items={[
          t({ itemId: "x:1" }),
          t({ itemId: "x:2" }),
          ...Array.from({ length: 21 }, (_, i) => t({ itemId: `x:1${i}`, status: "posted" })),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    screen.getByRole("button", { name: "전체 23" });
    screen.getByRole("button", { name: "대기 2" });
    screen.getByRole("button", { name: "승인 0" });
    screen.getByRole("button", { name: "게시됨 21" });
  });
});
