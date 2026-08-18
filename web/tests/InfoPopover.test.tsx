// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InfoPopover } from "../src/components/InfoPopover";

afterEach(cleanup);

/**
 * `PROMOTED_STYLE_TEXT`가 `48rem`을 두 번 하드코딩하는 이유(`InfoPopover.tsx`의 doc 주석 참조)는
 * CSS 커스텀 프로퍼티가 `@media` 안에서 쓰일 수 없어서다 — `--breakpoint-tablet`을 참조할 수 없다.
 * 그래서 이 저장소의 유일한 뷰포트 경계가 바뀌면 이 두 리터럴은 아무 에러 없이 조용히 따로 논다.
 * 이 테스트는 그 둘이 여전히 같은 값을 말하는지만 고정한다 — `styles.css`의 값이 진실이고, 여기
 * 두 리터럴이 그것을 따라가는지 본다.
 */
it("PROMOTED_STYLE_TEXT의 두 48rem이 --breakpoint-tablet과 일치한다", () => {
  const stylesCss = readFileSync(join(__dirname, "../src/styles.css"), "utf8");
  const breakpoint = stylesCss.match(/--breakpoint-tablet:\s*([\d.]+rem)/)?.[1];
  expect(breakpoint).toBeDefined();

  const infoPopoverSrc = readFileSync(join(__dirname, "../src/components/InfoPopover.tsx"), "utf8");
  const widths = [...infoPopoverSrc.matchAll(/width\s*[<>]=?\s*([\d.]+rem)/g)].map((m) => m[1]);
  expect(widths).toHaveLength(2);
  expect(widths[0]).toBe(breakpoint);
  expect(widths[1]).toBe(breakpoint);
});

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
  // 일부러 `<span>`이다, `<button>`이 아니라 — 이 블록은 래퍼 자신의 열기/닫기 메커니즘을
  // 검증하지, 자식이 자기 행동을 갖는 경우(진짜 버튼)를 검증하지 않는다. 후자는 아래
  // "활성(enabled) 자식 트리거" 블록의 몫이다. `<button>`으로 두면 `targetsEnabledControl`
  // (`InfoPopover.tsx`)이 이 버튼도 "이미 활성 컨트롤"로 보고 래퍼가 손을 떼므로, disabled도
  // 아니고 자기 onClick도 없는 이 자리에서는 `<span>`이 실제로 이 컴포넌트의 다른 실사용
  // (스토리지 모드 패널, 수집 카드 — 둘 다 `<span>` 자식)과 같은 모양이다.
  const setup = () =>
    render(
      <InfoPopover panel={<span>설명입니다</span>}>
        <span>열기</span>
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
   * 않기 때문이다 — `promotable`(= `supportsPromotion()`의 결과)이 항상 false가 된다.
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

  // 위 블록과 같은 이유로 `<span>` — 여기서 검증하는 것은 anchor positioning 배선이지 자식의
  // 활성 컨트롤 처리가 아니다.
  const setup = (align?: "left" | "right") =>
    render(
      <InfoPopover align={align} panel={<span>설명입니다</span>}>
        <span>열기</span>
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
   * 격리된 재현과 스크린샷은 task-3-report.md 참조.
   *
   * 실제 위치 계산은 더 이상 인라인 스타일이 아니라 `PROMOTED_STYLE_TEXT`(주입된 `<style>`)가
   * 한다 — 인스턴스가 여기서 결정하는 것은 `align`에 따라 `ip-panel--left`/`ip-panel--right` 중
   * 어느 클래스를 붙이느냐뿐이다. jsdom에는 레이아웃 엔진이 없어 그 클래스가 실제로 어느 쪽에
   * 붙는지는 여기서 볼 수 없다 — 390px/1280px 실측은 task-3-report.md 참조.
   */
  it('align 기본값("left")은 ip-panel--left를, align="right"는 ip-panel--right를 붙인다', () => {
    setup();
    fireEvent.click(screen.getByText("열기"));
    const leftPanel = screen.getByText("설명입니다").closest("[popover]") as HTMLElement;
    expect(leftPanel.classList.contains("ip-panel")).toBe(true);
    expect(leftPanel.classList.contains("ip-panel--left")).toBe(true);
    expect(leftPanel.classList.contains("ip-panel--right")).toBe(false);
    cleanup();

    setup("right");
    fireEvent.click(screen.getByText("열기"));
    const rightPanel = screen.getByText("설명입니다").closest("[popover]") as HTMLElement;
    expect(rightPanel.classList.contains("ip-panel--right")).toBe(true);
    expect(rightPanel.classList.contains("ip-panel--left")).toBe(false);
  });

  /**
   * `PROMOTED_STYLE_TEXT`가 실제로 문서에 주입되는지, 그리고 두 개의 `InfoPopover`가 동시에
   * promote되어도 중복으로 들어가지 않는지 확인한다. 이 stylesheet의 *내용*(`.ip-panel`의
   * over-constrained 방지, `tablet` 아래에서의 뷰포트 고정, `flip-inline`)은 jsdom이 레이아웃도
   * CSS 검증도 하지 않으므로 텍스트 포함 여부로만 핀으로 고정한다 — 값이 실제로 그렇게 계산되는지는
   * 여기서 증명할 수 없다는 뜻이다. 실제 계산 결과는 task-3-report.md의 390px/1280px 실측 참조.
   */
  it("promote되는 브라우저에서 위치 스타일시트를 한 번만 주입한다", () => {
    const first = render(
      <InfoPopover panel={<span>설명입니다 A</span>}>
        <span>열기 A</span>
      </InfoPopover>,
    );
    fireEvent.click(screen.getByText("열기 A"));
    const second = render(
      <InfoPopover panel={<span>설명입니다 B</span>}>
        <span>열기 B</span>
      </InfoPopover>,
    );
    fireEvent.click(screen.getByText("열기 B"));

    const styleEls = document.querySelectorAll("#info-popover-promoted-styles");
    expect(styleEls).toHaveLength(1);
    const css = styleEls[0].textContent ?? "";
    // over-constrained 방지 (UA `inset: 0`을 지운다).
    expect(css).toContain("right: auto");
    expect(css).toContain("bottom: auto");
    expect(css).toContain("left: auto");
    expect(css).toContain("margin: 0");
    // narrow: 뷰포트에 고정, 트리거에는 세로축만.
    expect(css).toContain("width < 48rem");
    expect(css).toContain("inset-inline: 1rem");
    expect(css).toContain("width: auto");
    // tablet 이상: 양쪽 축 다 트리거에, 넘치면 뒤집는다.
    expect(css).toContain("width >= 48rem");
    expect(css).toContain("flip-inline");
    expect(css).toContain(".ip-panel--left");
    expect(css).toContain(".ip-panel--right");

    first.unmount();
    second.unmount();
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

/**
 * 활성(enabled) 자식 — Task 10이 여덟 개의 활성 컨트롤(`되돌리기`, `✎ 따로 쓰기`, 드롭 `✕` 등)을
 * `Tip`으로 감싼 뒤에야 드러난 회귀. `onClick`/`onKeyDown`이 래퍼가 아니라 "래퍼까지 버블된 모든
 * 이벤트"에 반응하던 예전 코드는, disabled 자식(위 블록)에서만 옳았다 — disabled 자식은
 * `pointer-events-none` 덕에 클릭이 정말 래퍼 자신을 때리지만, 활성 자식은 클릭이 자식 자신을
 * 때리고 래퍼까지는 버블만 해온다. 그 차이를 `e.target === e.currentTarget`으로 보지 않으면
 * 래퍼가 자식의 클릭·키보드 이벤트를 자기 것처럼 가로챈다 — 실측된 두 증상: 터치에서 탭 한 번이
 * 자식의 동작과 팝오버 열기를 동시에 일으키고(닫을 방법이 폰에는 없다), 키보드에서는 래퍼의
 * `preventDefault()`가 포커스가 자식 위에 있어도 매번 먼저 불려 자식 버튼의 네이티브 Enter/Space
 * 활성화를 삼킨다.
 *
 * 여기서 검증 가능한 것: 자식에서 버블된 클릭·키다운은 래퍼를 토글하지 않고(`e.target`이 자식이지
 * 래퍼가 아니므로), 키다운 쪽은 `preventDefault()`도 불리지 않는다(`fireEvent`의 반환값이 그것을
 * 직접 증명한다 — 취소되면 `false`). "탭이 실제로 자식의 클릭을 실제 브라우저에서 억제 없이
 * 발생시키는가"는 disabled 블록과 같은 이유로 여기서 원리적으로 증명할 수 없다 — Playwright로
 * 실제 Chromium을 띄워 확인했다(작업 보고서 참조).
 */
describe("InfoPopover — 활성(enabled) 자식 트리거", () => {
  const setupEnabled = (onChildClick: () => void) =>
    render(
      <InfoPopover panel={<span>설명입니다</span>}>
        <button onClick={onChildClick}>열기</button>
      </InfoPopover>,
    );

  it("자식(버튼)에서 버블된 클릭은 래퍼를 토글하지 않는다 — 자식 자신의 onClick만 불린다", () => {
    const onChildClick = vi.fn();
    setupEnabled(onChildClick);
    fireEvent.click(screen.getByText("열기"));
    expect(onChildClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("설명입니다")).toBeNull();
  });

  it("자식에 포커스가 있을 때의 Enter는 래퍼에 막히지 않는다 — preventDefault가 불리지 않는다", () => {
    setupEnabled(() => {});
    const child = screen.getByText("열기");
    child.focus();
    const notCancelled = fireEvent.keyDown(child, { key: "Enter" });
    expect(notCancelled).toBe(true);
    expect(screen.queryByText("설명입니다")).toBeNull();
  });
});

/**
 * `keepMounted` — `MarkerText`의 hover-peek 전용 옵션(그 파일의 `MediaMarker` doc 참조). 기본값
 * `false`에서는 이 블록 이전의 모든 테스트가 이미 증명하는 대로 닫힐 때 패널이 언마운트된다 — 이
 * 블록은 `true`일 때만 갈라지는 부분(마운트가 살아남는지, 같은 DOM 노드를 재사용하는지)만 새로
 * 검증한다.
 */
describe("InfoPopover — keepMounted", () => {
  it("keepMounted가 없으면(기본값) 닫힐 때 패널이 DOM에서 사라진다", () => {
    render(
      <InfoPopover panel={<span>설명입니다</span>}>
        <span>열기</span>
      </InfoPopover>,
    );
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "mouse" });
    expect(screen.getByText("설명입니다")).toBeTruthy();
    fireEvent.pointerLeave(screen.getByText("열기"), { pointerType: "mouse" });
    expect(screen.queryByText("설명입니다")).toBeNull();
  });

  it("keepMounted면 닫혀도 패널이 DOM에 남고, hidden 클래스로만 감춘다", () => {
    render(
      <InfoPopover keepMounted panel={<span data-testid="p">설명입니다</span>}>
        <span>열기</span>
      </InfoPopover>,
    );
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "mouse" });
    expect(screen.getByTestId("p").closest(".hidden")).toBeNull();

    fireEvent.pointerLeave(screen.getByText("열기"), { pointerType: "mouse" });
    // 여전히 쿼리 가능해야 한다 — `queryByText`가 아니라 `getByTestId`를 쓰는 이유는 바로 그것,
    // 언마운트되었다면 이 호출 자체가 실패한다.
    expect(screen.getByTestId("p").closest(".hidden")).not.toBeNull();
  });

  it("keepMounted면 다시 열어도 같은 DOM 노드를 재사용한다 — 언마운트·리마운트가 없다", () => {
    render(
      <InfoPopover keepMounted panel={<span data-testid="p">설명입니다</span>}>
        <span>열기</span>
      </InfoPopover>,
    );
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "mouse" });
    const first = screen.getByTestId("p");
    fireEvent.pointerLeave(screen.getByText("열기"), { pointerType: "mouse" });
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "mouse" });
    const second = screen.getByTestId("p");
    expect(second).toBe(first);
  });

  it("keepMounted가 아닌 다른 인스턴스는 영향받지 않는다 — 기본값이 여전히 기본값이다", () => {
    // 이 저장소의 20여 다른 InfoPopover 호출처가 아무것도 바뀌지 않았다는 것을 한 번 더 못박는다.
    render(
      <InfoPopover panel={<span>A</span>}>
        <span>열기 A</span>
      </InfoPopover>,
    );
    fireEvent.click(screen.getByText("열기 A"));
    expect(screen.getByText("A")).toBeTruthy();
    fireEvent.click(screen.getByText("열기 A"));
    expect(screen.queryByText("A")).toBeNull();
  });
});

/**
 * `hoverDisabled` — 마찬가지로 `MarkerText` 전용. 핀(다른 메커니즘으로 이미 펼쳐진 상태)이 떠 있는
 * 동안 이 컴포넌트의 호버 패널이 얹혀 뜨는 것을 막는다.
 */
describe("InfoPopover — hoverDisabled", () => {
  it("hoverDisabled면 마우스가 들어와도 열리지 않는다", () => {
    render(
      <InfoPopover hoverDisabled panel={<span>설명입니다</span>}>
        <span>열기</span>
      </InfoPopover>,
    );
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "mouse" });
    expect(screen.queryByText("설명입니다")).toBeNull();
  });

  it("열려 있는 도중 hoverDisabled가 켜지면 (마운트는 유지한 채) 즉시 닫힌다", () => {
    const { rerender } = render(
      <InfoPopover keepMounted panel={<span data-testid="p">설명입니다</span>}>
        <span>열기</span>
      </InfoPopover>,
    );
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "mouse" });
    expect(screen.getByTestId("p").closest(".hidden")).toBeNull();

    rerender(
      <InfoPopover keepMounted hoverDisabled panel={<span data-testid="p">설명입니다</span>}>
        <span>열기</span>
      </InfoPopover>,
    );
    // 언마운트가 아니라 hidden으로 감춘 것 — `getByTestId`가 여전히 성공한다.
    expect(screen.getByTestId("p").closest(".hidden")).not.toBeNull();
  });

  it("hoverDisabled가 아닌 인스턴스는 평소처럼 호버로 열린다", () => {
    render(
      <InfoPopover panel={<span>설명입니다</span>}>
        <span>열기</span>
      </InfoPopover>,
    );
    fireEvent.pointerEnter(screen.getByText("열기"), { pointerType: "mouse" });
    expect(screen.getByText("설명입니다")).toBeTruthy();
  });
});
