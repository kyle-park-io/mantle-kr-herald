// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InfoPopover } from "../src/components/InfoPopover";

afterEach(cleanup);

/**
 * jsdom 30은 popover API의 JS 절반(`showPopover`/`hidePopover`)을 구현하지 않는다 — `showPopover`가
 * undefined이고 `:popover-open`은 매칭되지 않는다. 그래서 이 컴포넌트는 열림 상태를 React가 들고,
 * 네이티브 promotion(top layer로 올리고 CSS anchor positioning으로 트리거에 다시 묶는 것)은
 * `showPopover`와 `CSS.supports("anchor-name: --x")`가 둘 다 있을 때만 얹는 점진적 향상이다.
 * 여기서 검증하는 것은 그 상태 기계와, jsdom이 (`showPopover`가 없어서) promote를 건너뛴다는
 * 사실이다 — promote되는 경우는 아래 "anchor positioning을 지원하는 브라우저(스텁)" 블록에서
 * 따로 검증한다.
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
   * `showPopover`가 없는 브라우저(jsdom 포함)에서는 `popover` 속성 자체를 붙이지 않는다 — 붙이기만
   * 하고 `showPopover()`를 부르지 않으면, UA 스타일시트의 `[popover] { display: none }` 기본값이
   * `:popover-open` 여부와 무관하게 패널을 가려 버린다(jsdom 30도 이 부분은 실제로 구현한다). 이
   * 사실을 실제 Chromium이 아니라 여기서도 확인할 수 있는 건 jsdom이 `showPopover`를 아예 구현하지
   * 않기 때문이다 — `canPromote`가 항상 false가 된다.
   */
  it("jsdom(프로모션 불가)에서는 popover 속성을 붙이지 않는다", () => {
    setup();
    fireEvent.click(screen.getByText("열기"));
    expect(screen.getByText("설명입니다").closest("[popover]")).toBeNull();
  });
});

/**
 * `showPopover`가 있는(=native popover를 지원하는) 브라우저를 흉내 낸다. jsdom 30은 이 메서드를
 * 구현하지 않으므로(바로 위 블록의 마지막 테스트가 그 사실 자체를 검증한다) `HTMLElement.prototype`에
 * 직접 얹는다. `CSS.supports("anchor-name: --x")`는 스텁하지 않는다 — jsdom 30에서 이미 `true`를
 * 낸다(진짜 CSS 파서라기보다 프로퍼티 이름을 검증하지 않는 관대한 구현으로 보인다). 그래서 기본
 * jsdom이 promote를 건너뛰는 건 오로지 `showPopover`가 없기 때문이고, 이 블록은 그것만 채워서
 * 나머지 절반(anchor positioning 배선)을 검증한다.
 */
describe("InfoPopover — anchor positioning을 지원하는 브라우저(스텁)", () => {
  let showPopover: ReturnType<typeof vi.fn>;
  let hidePopover: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    showPopover = vi.fn();
    hidePopover = vi.fn();
    HTMLElement.prototype.showPopover = showPopover;
    HTMLElement.prototype.hidePopover = hidePopover;
  });

  afterEach(() => {
    cleanup();
    // jsdom의 `HTMLElement.prototype`에는 원래 이 메서드들이 없다 — 다른 값으로 덮어 두는 대신
    // 지워서, 이 블록 밖의 테스트가 다시 "구현되지 않은" 상태를 보게 한다.
    delete (HTMLElement.prototype as { showPopover?: unknown }).showPopover;
    delete (HTMLElement.prototype as { hidePopover?: unknown }).hidePopover;
  });

  const setup = (align?: "left" | "right") =>
    render(
      <InfoPopover align={align} panel={<span>설명입니다</span>}>
        <button>열기</button>
      </InfoPopover>,
    );

  it("popover=manual 속성을 붙이고 showPopover를 부른다", () => {
    setup();
    fireEvent.click(screen.getByText("열기"));
    const panel = screen.getByText("설명입니다").closest("[popover]");
    expect(panel?.getAttribute("popover")).toBe("manual");
    expect(showPopover).toHaveBeenCalled();
  });

  /**
   * top layer로 올라간 `position: absolute` 패널의 containing block은 트리거의 `position: relative`
   * 조상이 아니라 뷰포트가 된다 — 실제 Chromium에서 측정해 확인한 버그(Task 3 작업 보고서).
   * `anchor-name`/`position-anchor`가 트리거와 패널을 다시 묶어 주는 유일한 표준 경로이므로, 값이
   * 정확히 같은 커스텀 식별자로 양쪽에 걸리는지 확인한다. `useId()`의 `:`는 CSS 커스텀 식별자에
   * 쓸 수 없으므로 걸러진 값이어야 한다.
   */
  it("트리거에 anchor-name을, 패널에 같은 값의 position-anchor를 건다", () => {
    const { container } = setup();
    fireEvent.click(screen.getByText("열기"));
    const trigger = container.querySelector("[aria-controls]") as HTMLElement;
    const panel = screen.getByText("설명입니다").closest("[popover]") as HTMLElement;
    const anchorName = trigger.style.getPropertyValue("anchor-name");
    expect(anchorName).toMatch(/^--ip-[a-zA-Z0-9]+$/);
    expect(panel.style.getPropertyValue("position-anchor")).toBe(anchorName);
  });

  /**
   * `position-area`가 아니라 `anchor()` 함수로 4변을 직접 쓴다 — `position-area`(예:
   * `bottom span-left`)는 실제 Chromium(버전 150)에서 `align="right"` 방향의 기본 self-alignment가
   * 재현 가능하게 틀렸다(뷰포트 왼쪽 끝에 들러붙는다). `anchor()`는 양쪽 방향 모두 정확했다 —
   * 격리된 재현과 스크린샷은 task-3-report.md 참조. `right`/`left` 각각을 `calc(anchor(...))`로
   * 감싸는 이유는 jsdom의 CSSOM이 감싸지 않은 `anchor()`를 `top`/`right` 같은 알려진 프로퍼티에
   * 조용히 거부하기 때문이다(단일 값의 `calc()`는 수학적으로 no-op이라 실제 브라우저에서의 의미는
   * 같다).
   */
  it('align 기본값("left")은 트리거 왼쪽 경계, align="right"는 오른쪽 경계에 anchor()로 묶인다', () => {
    const { container: leftContainer } = setup();
    fireEvent.click(screen.getByText("열기"));
    const leftPanel = screen.getByText("설명입니다").closest("[popover]") as HTMLElement;
    const leftTrigger = leftContainer.querySelector("[aria-controls]") as HTMLElement;
    const leftAnchorName = leftTrigger.style.getPropertyValue("anchor-name");
    expect(leftPanel.style.getPropertyValue("left")).toBe(`calc(anchor(${leftAnchorName} left))`);
    expect(leftPanel.style.getPropertyValue("right")).toBe("auto");
    cleanup();

    const { container: rightContainer } = setup("right");
    fireEvent.click(screen.getByText("열기"));
    const rightPanel = screen.getByText("설명입니다").closest("[popover]") as HTMLElement;
    const rightTrigger = rightContainer.querySelector("[aria-controls]") as HTMLElement;
    const rightAnchorName = rightTrigger.style.getPropertyValue("anchor-name");
    expect(rightPanel.style.getPropertyValue("right")).toBe(`calc(anchor(${rightAnchorName} right))`);
    expect(rightPanel.style.getPropertyValue("left")).toBe("auto");
  });

  /**
   * `[popover]`의 UA 스타일시트 기본값은 `inset: 0`이다 — `top`/`right`/`bottom`/`left` 네 개가
   * 전부 명시적으로 `0`이지 `auto`가 아니다. 패널의 너비는 (호출처의 `panelClassName`으로) 확정값을
   * 갖는 경우가 흔하므로, `right`(또는 `left`)만 anchor 기준으로 새로 설정해도 반대쪽이 UA의
   * `0`으로 남아 있으면 과확정(over-constrained)되어 CSS 2.1 해소 규칙이 조용히 anchor 기준 값을
   * 무시해 버린다 — 실제로 그렇게 뷰포트 왼쪽 끝에 들러붙는 버그를 재현해서 잡았다(task-3-report.md).
   * `bottom`도 대칭성과 안전을 위해 지운다.
   */
  it("promote되지 않는 변(right 또는 left)과 bottom, margin은 UA 기본값을 지운다", () => {
    setup();
    fireEvent.click(screen.getByText("열기"));
    const panel = screen.getByText("설명입니다").closest("[popover]") as HTMLElement;
    expect(panel.style.getPropertyValue("bottom")).toBe("auto");
    expect(panel.style.getPropertyValue("margin")).toBe("0px");
  });

  /**
   * `max-w-[calc(100vw-2rem)]`는 패널의 *너비*만 뷰포트에 맞춰 줄인다 — 트리거 기준의 *오프셋*은
   * 그대로라, 헤더 오른쪽 절반에 가까운 트리거는 `align="left"`(기본값)로도 좁은 화면에서 패널이
   * 뷰포트 밖으로 나갈 수 있다. `anchor()`도 `position-area`도 스스로 뒤집지 않으므로
   * `position-try-fallbacks: flip-inline`이 필요하다 — 커스텀 `@position-try` 대신 내장 키워드를
   * 쓰는 이유는 Safari가 전자는 18.4+에서야 지원해서다. jsdom에는 레이아웃 엔진이 없어 실제로
   * 뒤집히는지는 여기서 볼 수 없다 — 390px 창에서의 실측은 task-3-report.md 참조. 여기서 확인하는
   * 것은 그 프로퍼티가 실제로 걸리는지뿐이다.
   */
  it("좁은 화면에서 넘치면 뒤집도록 position-try-fallbacks: flip-inline을 건다", () => {
    setup();
    fireEvent.click(screen.getByText("열기"));
    const panel = screen.getByText("설명입니다").closest("[popover]") as HTMLElement;
    expect(panel.style.getPropertyValue("position-try-fallbacks")).toBe("flip-inline");
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
