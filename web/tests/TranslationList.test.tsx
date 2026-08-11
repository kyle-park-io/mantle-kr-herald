// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/** 검색창에 값을 넣는다 — IME 조합 중에도 React가 보는 것과 같은 경로(onChange). */
const type = (value: string) => fireEvent.change(screen.getByLabelText("검색"), { target: { value } });

describe("TranslationList search", () => {
  const items = [
    t({ itemId: "x:1", koreanText: "맨틀 네트워크 메인넷 업데이트" }),
    t({ itemId: "x:2", koreanText: "이더리움 수수료 이야기" }),
    t({ itemId: "x:3", koreanText: "코스모스 소식", status: "approved" }),
  ];

  it("narrows the rows by initial consonants", () => {
    const { container } = render(<TranslationList items={items} selectedId={null} onSelect={() => {}} />);
    type("ㅁㅌ");
    expect(shownIds(container)).toEqual(["x:1"]);
  });

  /**
   * `count()`가 `props.items` 위에서 돌면 `전체 3`이 뜬 채 한 줄만 보인다 — 카운트가 생긴 이유였던
   * 착시가 그대로 돌아온다. 이 컴포넌트의 주석이 계약으로 적어둔 바로 그것.
   */
  it("narrows the tab counts with the rows", () => {
    render(<TranslationList items={items} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "전체 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "승인 1" })).toBeTruthy();

    type("ㅁㅌ");

    expect(screen.getByRole("button", { name: "전체 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "승인 0" })).toBeTruthy();
  });

  it("finds a row by its English source when the Korean does not say it", () => {
    const { container } = render(
      <TranslationList
        items={[t({ itemId: "x:9", koreanText: "한국어 본문", sourceText: "Mantle mainnet is live" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    type("mainnet");
    expect(shownIds(container)).toEqual(["x:9"]);
  });

  it("finds a row by the itemId a reviewer pasted in", () => {
    const { container } = render(<TranslationList items={items} selectedId={null} onSelect={() => {}} />);
    type("x:2");
    expect(shownIds(container)).toEqual(["x:2"]);
  });

  it("says nothing matched rather than showing a stale list", () => {
    render(<TranslationList items={items} selectedId={null} onSelect={() => {}} />);
    type("ㅋㅋㅋㅋ");
    expect(screen.getByText("해당하는 항목이 없습니다.")).toBeTruthy();
  });
});
