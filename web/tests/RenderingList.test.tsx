// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RenderingList } from "../src/components/RenderingList";
import type { Rendering } from "../src/types";

afterEach(cleanup);

function r(over: Partial<Rendering> & { itemId: string }): Rendering {
  return {
    type: "announcement",
    channel: "telegram",
    text: "본문",
    refined: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    status: "rendered",
    convertedText: "",
    ...over,
  };
}

/** 목록에 남은 아이템 id들. 행 버튼만 `x:`를 담는다 (검색창도 지우기 버튼도 담지 않는다). */
function shownIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .filter((s) => s.includes("x:"))
    .map((s) => /x:\d+/.exec(s)?.[0] ?? "");
}

const type = (value: string) => fireEvent.change(screen.getByLabelText("검색"), { target: { value } });

describe("RenderingList order", () => {
  it("puts the newest source post first, like 1차", () => {
    // `/api/renderings` returns `loadAll()`'s `order by ordinal` — insertion order, oldest-first —
    // so the card a reviewer most likely wants sat at the bottom of a scrolling sidebar.
    const { container } = render(
      <RenderingList
        items={[
          r({ itemId: "x:1", postedAt: "2026-07-28T00:00:00.000Z" }),
          r({ itemId: "x:3", postedAt: "2026-08-06T00:00:00.000Z" }),
          r({ itemId: "x:2", postedAt: "2026-08-01T00:00:00.000Z" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(shownIds(container)).toEqual(["x:3", "x:2", "x:1"]);
  });

  it("falls back to the newest card's createdAt when an item has no source post date", () => {
    // `postedAt` is joined from the source item and can be absent — a row missing that join must not
    // sink to the bottom as though it were the oldest thing on the board.
    const { container } = render(
      <RenderingList
        items={[
          r({ itemId: "x:1", postedAt: "2026-07-28T00:00:00.000Z" }),
          r({ itemId: "x:2", createdAt: "2026-08-07T00:00:00.000Z" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(shownIds(container)).toEqual(["x:2", "x:1"]);
  });

  it("orders by id when two items share a date, so the list never reshuffles between renders", () => {
    const same = "2026-08-01T00:00:00.000Z";
    const { container } = render(
      <RenderingList
        items={[r({ itemId: "x:100", postedAt: same }), r({ itemId: "x:200", postedAt: same })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(shownIds(container)).toEqual(["x:200", "x:100"]);
  });

  it("sorts by the item's newest card, not by whichever card the (type, channel) order puts first", () => {
    // An item's cards are not created together — `pnpm format --only-missing` adds a channel later,
    // and 카카오 sorts after 텔레그램 regardless of when either was rendered.
    const { container } = render(
      <RenderingList
        items={[
          r({ itemId: "x:1", type: "announcement", channel: "telegram", createdAt: "2026-08-02T00:00:00.000Z" }),
          r({ itemId: "x:2", type: "announcement", channel: "telegram", createdAt: "2026-08-01T00:00:00.000Z" }),
          r({ itemId: "x:2", type: "kakao_notice", channel: "kakao", createdAt: "2026-08-09T00:00:00.000Z" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(shownIds(container)).toEqual(["x:2", "x:1"]);
  });
});

describe("RenderingList search", () => {
  /**
   * 한 아이템의 카드는 여러 장이고 미리보기는 첫 장뿐이다. 오픈카톡 카드에만 있는 문구로 검색해도
   * 행이 남아야 한다 — 행의 역할은 보드를 여는 것이지 매치를 증명하는 것이 아니다.
   */
  it("keeps an item whose match is on a card the preview does not show", () => {
    const { container } = render(
      <RenderingList
        items={[
          r({ itemId: "x:1", type: "announcement", channel: "telegram", text: "텔레그램 공지 문구" }),
          // 같은 아이템의 두 번째 카드. 공지 분리 뒤 오픈카톡 카드는 `kakao_notice`다 — 한 변환이
          // 두 채널로 퍼지는 것이 아니라 유형이 둘이다.
          r({ itemId: "x:1", type: "kakao_notice", channel: "kakao", text: "카카오에만 있는 에어드랍 안내" }),
          r({ itemId: "x:2", text: "관계없는 다른 아이템" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    type("에어드랍");
    expect(shownIds(container)).toEqual(["x:1"]);
  });

  it("matches by initial consonants and by itemId", () => {
    const { container } = render(
      <RenderingList
        items={[r({ itemId: "x:1", text: "맨틀 네트워크 공지" }), r({ itemId: "x:2", text: "다른 소식" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    type("ㅁㅌ");
    expect(shownIds(container)).toEqual(["x:1"]);
    type("x:2");
    expect(shownIds(container)).toEqual(["x:2"]);
  });

  it("ands with the channel filter rather than replacing it", () => {
    const { container } = render(
      <RenderingList
        items={[
          r({ itemId: "x:1", channel: "telegram", text: "맨틀 텔레그램" }),
          r({ itemId: "x:2", type: "kakao_notice", channel: "kakao", text: "맨틀 카카오" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    fireEvent.change(screen.getByDisplayValue("모든 채널"), { target: { value: "kakao" } });
    type("맨틀");
    expect(shownIds(container)).toEqual(["x:2"]);
  });

  it("says nothing matched rather than showing a stale list", () => {
    render(<RenderingList items={[r({ itemId: "x:1", text: "맨틀" })]} selectedId={null} onSelect={() => {}} />);
    type("ㅋㅋㅋㅋ");
    expect(screen.getByText("해당하는 항목이 없습니다.")).toBeTruthy();
  });
});

/**
 * `Rendering.text` still carries media markers verbatim — `FormatVariants` stores the joined,
 * bold-adjusted canonical text, and only `emit()`'s per-destination formatting (never stored, only
 * shown on send) calls `stripMedia`. So this row's preview had the identical leak `TranslationList`'s
 * had, on the identical kind of text. Same fix (`mediaFreePreview`, `MediaBadge` — both imported from
 * `TranslationList.tsx` rather than re-implemented).
 */
describe("RenderingList preview strips media markers, but the badge still says so", () => {
  it("미리보기 텍스트에는 CDN url도 마커 라벨도 남지 않는다", () => {
    const { container } = render(
      <RenderingList
        items={[r({ itemId: "x:1", text: "이번 주 소식입니다\n\n[사진](https://pbs.twimg.com/media/abc.jpg)" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(container.textContent).toContain("이번 주 소식입니다");
    expect(container.textContent).not.toContain("pbs.twimg.com");
    expect(container.textContent).not.toContain("[사진]");
  });

  it("사진 두 장을 담은 행은 사진 2 배지를 보여준다", () => {
    render(
      <RenderingList
        items={[r({ itemId: "x:1", text: "본문\n\n[사진](https://a.jpg)\n\n[사진](https://b.jpg)" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("사진 2")).toBeTruthy();
  });

  it("url이 없는 [영상] 마커도 영상 1 배지로 센다", () => {
    render(<RenderingList items={[r({ itemId: "x:1", text: "본문\n\n[영상]" })]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("영상 1")).toBeTruthy();
  });

  it("마커가 없는 행에는 미디어 배지가 없다", () => {
    render(<RenderingList items={[r({ itemId: "x:1", text: "그냥 본문" })]} selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByText(/^사진 /)).toBeNull();
    expect(screen.queryByText(/^영상 /)).toBeNull();
  });

  it("미리보기가 마커를 지워도 검색은 여전히 원문 전체(마커 포함)를 훑는다", () => {
    const { container } = render(
      <RenderingList
        items={[r({ itemId: "x:1", text: "본문 [사진](https://pbs.twimg.com/media/UNIQUEMARKERWORD.jpg)" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    type("UNIQUEMARKERWORD");
    expect(shownIds(container)).toEqual(["x:1"]);
  });
});
