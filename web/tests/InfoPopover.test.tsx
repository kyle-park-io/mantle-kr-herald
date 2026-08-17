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

/**
 * disabled인 `children` — `Tip`의 주 사용례이지 엣지 케이스가 아니다(`ConfirmDialog.tsx`의 `Tip`
 * 주석 참조: 아홉 개의 "왜 못 누르나" 메시지가 정확히 이 형태로 아무에게도 안 보인 채 쌓여 있었다).
 *
 * 이 파일에서 검증할 수 있는 절반과, 없는 절반이 갈린다.
 *
 * 검증 가능한 절반 — 키보드: jsdom은 포커스 가능 여부를 스펙대로 구현한다(disabled 네이티브
 * 컨트롤은 `.focus()`를 걸어도 `activeElement`가 되지 않는다 — 아래 첫 테스트가 그것 자체를
 * 확인한다). 그래서 "트리거 래퍼가 `tabIndex`로 포커스를 받고, 포커스 상태에서 Enter·Space가
 * 열고 닫는다"는 jsdom에서도 참으로 실패할 수 있는 테스트다.
 *
 * 검증 불가능한 절반 — 포인터: `[&_:disabled]:pointer-events-none`이 실제로 하는 일은 브라우저의
 * 레이아웃·히트테스트 엔진이 그 좌표의 클릭을 disabled 자손이 아니라 래퍼에게 준다는 것인데,
 * jsdom에는 레이아웃 엔진이 없다 — `pointer-events` CSS를 히트테스트에 반영할 방법 자체가 없다.
 * 더 근본적으로는 `fireEvent.click`이 진짜 문제의 원인이다: 실제 브라우저는 disabled 폼
 * 컨트롤에 click을 아예 "발생시키지 않는" 반면, `fireEvent.click(disabledButton)`은 노드에 직접
 * `dispatchEvent`를 걸어 그 억제를 무시하고 이벤트를 발생·버블시킨다 — 바로 이 간극이 fix round 1의
 * Critical 리뷰 결과였다("여섯 개 테스트가 통과하는 이유는 jsdom이 네이티브 억제를 우회하기
 * 때문"). 그래서 "disabled 버튼을 실제로 클릭하면 래퍼가 열리는가"는 이 파일이 원리적으로
 * 대답할 수 없는 질문이고, 초록 테스트로 그것을 증명한 것처럼 읽으면 안 된다 — Playwright로 실제
 * Chromium을 띄워 확인했다(작업 보고서 참조).
 */
describe("InfoPopover — disabled 트리거", () => {
  const setupDisabled = () =>
    render(
      <InfoPopover panel={<span>설명입니다</span>}>
        <button disabled>열기</button>
      </InfoPopover>,
    );

  it("disabled 버튼 자신은 포커스를 받지 못한다 — 이 스위트가 기대는 전제", () => {
    setupDisabled();
    const btn = screen.getByText("열기") as HTMLButtonElement;
    btn.focus();
    expect(document.activeElement).not.toBe(btn);
  });

  it("자식이 disabled여도 트리거 래퍼는 포커스를 받는다", () => {
    const { container } = setupDisabled();
    const trigger = container.querySelector("[aria-expanded]") as HTMLElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it("포커스된 래퍼에서 Enter를 누르면 열리고, 다시 누르면 닫힌다", () => {
    const { container } = setupDisabled();
    const trigger = container.querySelector("[aria-expanded]") as HTMLElement;
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getByText("설명입니다")).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.queryByText("설명입니다")).toBeNull();
  });

  it("Space로도 열린다", () => {
    const { container } = setupDisabled();
    const trigger = container.querySelector("[aria-expanded]") as HTMLElement;
    trigger.focus();
    fireEvent.keyDown(trigger, { key: " " });
    expect(screen.getByText("설명입니다")).toBeTruthy();
  });
});
