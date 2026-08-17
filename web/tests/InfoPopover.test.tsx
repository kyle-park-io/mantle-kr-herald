// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InfoPopover } from "../src/components/InfoPopover";

afterEach(cleanup);

/**
 * jsdom 30은 popover API를 구현하지 않는다 — `showPopover`가 undefined이고 `:popover-open`은
 * 매칭되지 않는다. 그래서 이 컴포넌트는 열림 상태를 React가 들고, 네이티브 popover는 실제
 * 브라우저에서 top layer로 올리는 점진적 향상으로만 쓴다. 여기서 검증하는 것은 그 상태 기계다.
 */
describe("InfoPopover", () => {
  const setup = () =>
    render(
      <InfoPopover panel={<span>설명입니다</span>}>
        <button>열기</button>
      </InfoPopover>,
    );

  it("처음에는 카드가 없다", () => {
    setup();
    expect(screen.queryByText("설명입니다")).toBeNull();
  });

  it("클릭하면 열리고, 다시 클릭하면 닫힌다 — 터치·키보드의 유일한 경로", () => {
    setup();
    fireEvent.click(screen.getByText("열기"));
    expect(screen.getByText("설명입니다")).toBeTruthy();
    fireEvent.click(screen.getByText("열기"));
    expect(screen.queryByText("설명입니다")).toBeNull();
  });

  it("마우스가 들어오면 열린다", () => {
    setup();
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "mouse" });
    expect(screen.getByText("설명입니다")).toBeTruthy();
  });

  it("손가락이 들어와도 열지 않는다 — 탭이 곧바로 열고 닫는 것을 막는다", () => {
    setup();
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "touch" });
    expect(screen.queryByText("설명입니다")).toBeNull();
  });

  it("마우스가 나가면 닫히지만, 손가락이 나가는 것으로는 닫히지 않는다", () => {
    setup();
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "mouse" });
    fireEvent.pointerLeave(screen.getByText("열기"), { pointerType: "touch" });
    expect(screen.getByText("설명입니다")).toBeTruthy();
    fireEvent.pointerLeave(screen.getByText("열기"), { pointerType: "mouse" });
    expect(screen.queryByText("설명입니다")).toBeNull();
  });

  it("Esc로 닫힌다", () => {
    setup();
    fireEvent.click(screen.getByText("열기"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("설명입니다")).toBeNull();
  });

  /**
   * React 18의 `@types/react`(18.3.31 기준) `HTMLAttributes`에는 `popover`가 없다 — canary 타입에만
   * 있다. JSX 속성으로 `popover="manual"`을 쓰면 `pnpm typecheck:web`이 깨지므로, 이 컴포넌트는
   * `useEffect`에서 `el.setAttribute("popover", "manual")`로 직접 붙인다. React 18이 알 수 없는
   * 소문자 속성을 그대로 DOM에 통과시키는 런타임 동작 자체는 사실이지만, 타입 체크를 통과시키려면
   * 어차피 이 경로가 필요하다 — 여기서 실제로 속성이 붙는지 확인한다.
   */
  it("패널에 popover=manual 속성이 실제로 붙는다", () => {
    setup();
    fireEvent.click(screen.getByText("열기"));
    expect(screen.getByText("설명입니다").closest("[popover]")?.getAttribute("popover")).toBe("manual");
  });
});
