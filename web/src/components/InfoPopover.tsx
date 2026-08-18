import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * 보드의 호버 카드 idiom 하나. `group` + `absolute top-full` + `hidden … group-hover:block`으로
 * 손으로 쓰던 네 곳(`App.tsx`의 스토리지 패널, `CollectedBreakdownCard`, `Tip`, `OpenLink`)이 여기로
 * 모인다. `MarkerText`는 이 목록에 없었다 — Task 5가 그것을 클릭 전용 인라인 아코디언으로 바꿨다,
 * 팝오버는 정확히 그것이 설명하는 텍스트를 덮어버리기 때문에. 이후 다른 작업이 그 결정을 데스크톱
 * 마우스에서 되돌렸다: 호버는 이 컴포넌트를 `keepMounted`+`hoverDisabled`로 얹어 뜨는 "peek"를 열고,
 * 클릭·탭은 여전히 `MediaMarker` 자신의 인라인 확장("pin")을 연다 — 아래 두 prop의 doc 참조. 둘은
 * 같은 마커에서 동시에 뜨지 않는다: 핀이 열리면 `hoverDisabled`가 이 컴포넌트의 `open`을 (마운트는
 * 유지한 채) 닫는다.
 *
 * 왜 호버만으로는 안 되는가: Tailwind v4는 `hover:`를 `@media (hover: hover)`로 감싸 내보내므로
 * 터치 기기에서는 확정적으로 열리지 않는다. 그리고 그것은 모바일만의 문제가 아니다 — 호버가
 * 유일한 경로인 카드는 데스크톱에서 키보드로도 볼 수 없다.
 *
 * 왜 네이티브 `popover`인가: 패널이 top layer로 올라가 조상의 `overflow`에 잘릴 수 없게 된다.
 * `App.tsx`가 헤더에 `overflow-x-auto`를 못 쓰는 이유가 정확히 그 잘림이었다(그 파일의 주석
 * 참조). Esc와 바깥 클릭 닫기도 브라우저가 해준다.
 *
 * 왜 CSS Anchor Positioning(`anchor-name`/`position-anchor`/`anchor()`)도 함께 필요한가: top
 * layer로 올라간 `position: absolute` 엘리먼트의 containing block은 더 이상 트리거의
 * `position: relative` 조상이 아니라 초기 containing block(뷰포트)이 된다 — 그 상태의
 * `top-full left-0`는 트리거가 아니라 뷰포트 좌하단을 가리킨다. 실제 Chromium으로 직접 측정해서
 * 확인한 버그다: anchor positioning 없이 promote한 패널의 `getBoundingClientRect()`가
 * `{ top: window.innerHeight, left: 0 }`였다(Task 3 작업 보고서 참조) — 헤더에 잘리지는 않지만
 * 트리거와 아무 관계 없는 위치에 뜬다. CSS Anchor Positioning은 top layer로 올라간 뒤에도 패널을
 * 트리거에 다시 묶어주는 유일한 표준 방법이라, 이것이 없는 브라우저에서는 애초에 promote하지
 * 않는다(아래 `supportsPromotion` 참조) — JS로 좌표를 계산하는 대신인 이유는 그러면 스크롤·리사이즈
 * 리스너가 열린 팝오버마다 필요해지는데, anchor positioning은 그 두 경우 모두 공짜로 따라오기
 * 때문이다.
 *
 * `position-area`가 아니라 저수준 `anchor()` 함수로 4변을 직접 쓰는 이유: `position-area`(예:
 * `bottom span-left`)의 기본 self-alignment가 실제 Chromium(버전 150)에서 한쪽 방향
 * (`align="left"`, 트리거 왼쪽 경계에서 오른쪽으로)은 맞게 나오지만 반대 방향(`align="right"`,
 * 트리거 오른쪽 경계에서 왼쪽으로)은 재현 가능하게 틀렸다 — 뷰포트 왼쪽 끝에 들러붙는다.
 * `justify-self: end`도, `position-try-fallbacks: none`도, 충돌하는 inset을 미리 지우는 것도
 * 고치지 못했다. `anchor()`는 양쪽 방향 모두 정확했다(격리된 재현과 스크린샷은 task-3-report.md
 * 참조). 네 변을 먼저 전부 `auto`로 미는 이유는 아래 `PROMOTED_STYLE_TEXT`의 주석에 있다.
 *
 * 왜 `tablet` 아래에서는 양쪽 축이 아니라 한 축만 트리거에 묶는가: `w-72`/`w-80` 같은 패널은 390px
 * 폰에서 트리거가 화면 중앙 근처에 있으면 `flip-inline`으로도 못 피한다 — 왼쪽 정렬로 펴도, 뒤집어
 * 오른쪽 정렬로 펴도 반대쪽이 넘친다(양쪽 다 남는 여유가 패널 너비보다 작으면 필연적이다). 인라인
 * 축(왼쪽/오른쪽)을 트리거가 아니라 뷰포트 자체에 고정하면(`inset-inline` + `width: auto`) 이
 * 문제 자체가 사라진다 — promote된 패널의 실제 계산값은 top layer 안에서도 `position: absolute`다
 * (UA `[popover]` 시트가 미는 기본값은 `position: fixed`이지만, Tailwind의 `.absolute`가 그것을
 * 이긴다 — 실제 Chromium에서 `getComputedStyle`로 확인했다). 그래도 top layer로 올라간
 * `position: absolute` 엘리먼트의 containing block은 여전히 initial containing block, 즉
 * 뷰포트이므로 결론은 같다: 이것은 메커니즘을 거스르는 편법이 아니라 메커니즘이 이미 준
 * containing block을 그대로 쓰는 것이다. 세로 축(트리거 바로 아래)은 그대로 유지한다 — 카드가 트리거와
 * 무관한 위치로 떠 보이는 것을 막는 것이 애초에 anchor positioning을 쓰는 이유였다.
 *
 * 이것은 `@container`가 아니라 뷰포트 쿼리(`tablet` 미디어쿼리)로 가른다 — 이 저장소의 계획 문서는
 * "셸만 뷰포트 쿼리를 쓰고 컴포넌트 내부 분기는 `@container`를 쓴다"고 못박지만, top layer로 올라간
 * 엘리먼트의 containing block은 문자 그대로 뷰포트이지 이 컴포넌트를 담은 어떤 박스도 아니다 —
 * 이 위치를 좌우할 발언권이 있는 컨테이너 자체가 없으므로 `@container`로 잴 대상이 없다(컨트롤러
 * 재정). 아래 `PROMOTED_STYLE_TEXT`가 그 미디어쿼리를 담는다.
 *
 * 왜 그런데도 열림 상태를 React가 드는가: jsdom 30이 popover API를 구현하지 않기 때문이다.
 * `showPopover`는 undefined이고 `:popover-open`은 매칭되지 않으므로, DOM 상태에만 기대면 web
 * 테스트에서 검증할 수 있는 것이 없다. 그래서 상태는 여기가 들고, `showPopover()`는 있을 때만
 * 부르는 점진적 향상으로 얹는다. 브라우저가 스스로 닫은 경우(Esc·바깥 클릭)는 `toggle` 이벤트로
 * 상태에 되돌려 받는다.
 *
 * 입력 장치 판별에 `pointerType`을 쓰는 이유: `(hover: hover)` 미디어쿼리는 기기 하나에 하나의
 * 답만 주지만, 터치스크린 달린 노트북은 둘 다다. 이벤트마다 묻는 쪽이 정확하다.
 *
 * `role`을 기본값 없이 두는 이유: 이 컴포넌트를 쓰는 패널 중에는 안에 버튼·링크가 들어가는 것도
 * 있다(예: 스토리지 모드 패널의 `지금 확인` 버튼) — 상호작용 요소를 `role="tooltip"` 안에 두면
 * 스크린 리더가 그 요소를 도달 불가능한 것으로 취급할 수 있다. 그래서 `role`은 호출처가 필요할
 * 때만 넘긴다. 텍스트 한 덩이일 뿐인 `Tip`은 `role="tooltip"`을 넘긴다.
 *
 * disabled인 `children`이 왜 특별 취급인가: `Tip`의 주요 용도가 disabled된 컨트롤이 눌리지 않는
 * 이유를 설명하는 것이다(`ConfirmDialog.tsx`의 `Tip` 주석 참조) — 즉 disabled 컨트롤이 이
 * 컴포넌트의 엣지 케이스가 아니라 주 사용례다. 그런데 네이티브 disabled 폼 컨트롤은 클릭을
 * "무시"하는 게 아니라 브라우저가 애초에 click을 발생시키지 않는다(포인터·키보드 둘 다), 그리고
 * 탭 순서에서도 빠진다. 트리거 래퍼의 `[&_:disabled]:pointer-events-none`과 자체 `tabIndex`·
 * `onKeyDown`이 그 두 경로를 각각 고친다 — 아래 트리거 주석에 자세히 있다.
 */

// 함수로 두는 이유는 캐싱이 아니라 정반대다 — 매번 `HTMLElement.prototype.showPopover`를 다시
// 읽는다. 모듈 로드 시점에 한 번 계산해 상수로 굳히면(실제 브라우저에서는 세션 중 안 바뀌니 굳혀도
// 되는 값이지만) 이 파일의 테스트가 깨진다: `import`가 실행되는 순간(테스트 파일 맨 위)에는 아직
// `beforeEach`의 프로토타입 스텁이 붙기 전이라, 값이 영원히 `false`로 굳어 버려서 스텁이 이후에
// 무엇을 해도 반영되지 않는다(직접 겪은 회귀 — 굳힌 상수로 먼저 짰다가 스텁 기반 테스트 4개가
// 한꺼번에 깨졌다).
function supportsPromotion(): boolean {
  return (
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.showPopover === "function" &&
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("anchor-name: --x")
  );
}

/**
 * Critical 1's fix. `Tip` was built assuming its only children were ever disabled controls — the
 * trigger wrapper's own `onClick`/`onKeyDown` fired on ANY event that reached it, bubbled or not,
 * because a bubbled event from a disabled descendant was the only case that ever happened (disabled
 * controls generate no click/keydown of their own; the wrapper had to invent one). Task 10 then
 * wrapped eight *enabled* controls in `Tip` (`되돌리기`, `✎ 따로 쓰기`, the drop `✕`, …), and the
 * premise stopped holding: a tap on one of those now fired the control's own action AND toggled the
 * wrapper at once (no outside-click/Esc on a phone to undo it), and the wrapper's unconditional
 * `preventDefault()` on Enter/Space swallowed the control's native keyboard activation before it
 * ever ran.
 *
 * The fix has to tell these two cases apart: an event that lands on the wrapper itself (or on inert
 * content with no behaviour of its own — a plain `<span>` badge, the storage-mode pill, the funnel's
 * `수집` count) is the wrapper's own to act on; an event that lands on a control which already has
 * (or will have) its own enabled, native activation is not — the wrapper has to back off and let
 * that control's own click/keyboard handling run unimpeded.
 *
 * `e.target === e.currentTarget` alone is not that test: `e.target` for a click is the actual
 * element under the pointer regardless of who has a listener, so it is almost NEVER the wrapper
 * itself once there is any visible child at all — that check would also silence the storage-mode
 * panel and the funnel breakdown card's own click-to-open (both wrap plain, non-interactive `<span>`
 * content with no listener of their own), which nothing in this fix is asking to break. The walk
 * below asks the narrower, correct question instead: is there a *native, enabled, interactive*
 * element between `e.target` and the wrapper boundary? If yes, that element owns the event. If no —
 * whether because `e.target` IS the wrapper (a disabled child's click, redirected here by
 * `[&_:disabled]:pointer-events-none` — a real pointer's hit-test skips a `pointer-events: none`
 * descendant entirely and lands on the wrapper directly) or because every node in between is inert —
 * the wrapper owns it, exactly as it always did for a disabled child.
 *
 * This also makes the disabled path correct in jsdom, not only in a real browser's hit-testing:
 * `fireEvent.click` dispatches straight at whatever node the test calls it on, bypassing hit-testing
 * entirely, so a test that clicks a *disabled* `<button>` directly still lands with `target` on that
 * button — this walk explicitly excludes a `.disabled` element from counting as "owns the event," so
 * it keeps working there too, not only when a real pointer's hit-test does the redirecting for it.
 */
function targetsEnabledControl(target: EventTarget | null, boundary: Element): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== boundary) {
    if (
      el.matches("button, a, input, select, textarea, [role='button']") &&
      !(el as HTMLButtonElement | HTMLInputElement).disabled
    ) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

const PROMOTED_STYLE_ID = "info-popover-promoted-styles";

/**
 * promote된 패널의 위치는 이제 인라인 스타일이 아니라 이 한 장의 stylesheet가 정한다 — 인스턴스마다
 * 다른 것은 `anchor-name`/`position-anchor`의 *값* 뿐이고(여전히 JS로 붙인다, 아래 effect 참조),
 * `anchor()` 호출 자체는 인자 없는 암시 형태(`anchor(bottom)`)를 써서 `position-anchor`가 가리키는
 * anchor를 그대로 따라간다 — 그래서 이 텍스트는 인스턴스와 무관하게 완전히 정적이다.
 *
 * `styles.css`에 넣지 않는 이유: 이 저장소의 전역 제약이 그 파일에 `@media` 블록을 직접 쓰는 것을
 * 금지한다. 여기서는 그 파일을 건드리지 않고, 이 컴포넌트가 처음 promote될 때 `<style>` 엘리먼트를
 * 한 번만 주입한다(여러 `InfoPopover` 인스턴스가 중복으로 넣지 않도록 id로 존재를 먼저 확인한다).
 *
 * `.ip-panel`의 기본 규칙이 `right`/`bottom`/`left`/`margin`을 먼저 미는 이유는 위 doc 주석의
 * over-constrained 설명과 같다 — `top`은 없다: 아래 두 미디어쿼리가 always 서로 배타적으로 전체
 * 폭을 덮으므로 `top`은 항상 둘 중 하나가 실제 값으로 덮어써서, `auto`를 거칠 일이 없다.
 *
 * `top`이 `anchor(bottom) + 0.375rem`이 아니라 그냥 `anchor(bottom)`인 이유, 그리고 아래 JSX가
 * 패널을 두 겹(바깥/안쪽) 박스로 그리는 이유는 한 버그의 앞뒤다. 트리거와 패널 사이의 여백을
 * `top`의 덧셈으로(또는 그 전의 un-promoted 경로처럼 `margin`으로) 주면 그 여백은 엘리먼트
 * *자신의* 히트테스트 영역 바깥에 남는다 — 포인터가 트리거에서 패널로 곧장 내려가다 그 몇 픽셀
 * 띠를 지나는 순간 `pointerleave`가 뜨고 패널이 닫혀, 패널 자체에는 영영 도달하지 못한다. 이
 * 저장소가 이미 한 번 고쳤던 자리다 — `App.tsx`의 커밋 `bd2baa7`에서 지워진 주석: "margin sits
 * outside an element's own hit-test area, padding sits inside it. Splitting the box keeps the
 * visible result identical … while making that whole 8px strip hit-testable." 그래서 여백은 이제
 * 바깥 박스의 `pt-1.5`(패딩)이고, `top`은 정확히 `anchor(bottom)`을 가리킨다 — 바깥 박스 자신이
 * 트리거 바로 아래에서 시작해 화면에 보이지 않는 채로 그 패딩만큼 안쪽(보이는) 박스를 밀어낸다.
 * 마우스가 트리거에서 패널로 내려가는 경로 전체가 이제 어느 한 엘리먼트의 히트테스트 영역
 * 안이다.
 *
 * 아래 JSX의 안쪽(보이는) 박스가 `promotable`일 때 `ip-panel`(align 변형 없이 기본 클래스만)을
 * 함께 받는 이유는 위치 때문이 아니다 — 그 박스는 `position: static`이라 `anchor()`/`inset-inline`
 * 같은 위치 프로퍼티는 전부 무시된다. 폭 때문이다: 아래 좁은 화면 미디어쿼리가 미는
 * `width: auto`가 바깥 박스뿐 아니라 이 박스의 `panelClassName`발 `w-*`도 같이 덮어써야,
 * `inset-inline`으로 뷰포트 양끝에 고정된 바깥 박스를 안쪽(보이는) 박스가 실제로 채운다 — 안
 * 그러면 바깥은 넓어지는데 눈에 보이는 카드는 원래 `w-64`/`w-72`/`w-80`에 그대로 남아, 보이는
 * 결과가 이 restructuring 이전과 달라진다.
 */
const PROMOTED_STYLE_TEXT = `
.ip-panel {
  top: anchor(bottom);
  right: auto;
  bottom: auto;
  left: auto;
  margin: 0;
}
@media (width < 48rem) {
  .ip-panel {
    inset-inline: 1rem;
    width: auto;
  }
}
@media (width >= 48rem) {
  .ip-panel {
    position-try-fallbacks: flip-inline;
  }
  .ip-panel--left {
    left: anchor(left);
  }
  .ip-panel--right {
    right: anchor(right);
  }
}
`;

function ensurePromotedStylesInjected() {
  if (typeof document === "undefined" || document.getElementById(PROMOTED_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PROMOTED_STYLE_ID;
  style.textContent = PROMOTED_STYLE_TEXT;
  document.head.appendChild(style);
}

export function InfoPopover({
  panel,
  align = "left",
  className,
  panelClassName,
  role,
  keepMounted = false,
  hoverDisabled = false,
  children,
}: {
  panel: ReactNode;
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
  role?: string;
  /**
   * `MarkerText`'s hover-peek is the only caller that needs this. Every other panel here is cheap
   * text, and unmounting it on close (the default) is strictly better — less DOM sitting idle. A
   * peek panel can hold a `<video autoPlay>`: unmounting it on every `pointerleave` would restart
   * playback and refetch the clip on the very next hover, which is exactly what deferred mount
   * (`MediaMarker`'s own doc comment) exists to prevent. `keepMounted` keeps the panel element in
   * the DOM once it has opened at least once — closing afterward only hides it (a `hidden` class
   * here; a promoted panel additionally gets a real `hidePopover()`, see the effect below) instead
   * of removing it, so whatever lives inside `panel` is built once and reused for every later open.
   * Default false, so none of this component's other 20+ call sites change behaviour.
   */
  keepMounted?: boolean;
  /**
   * Also for `MarkerText`: a marker can be pinned open (its own inline expansion, not this
   * component) while the pointer is still hovering it. Without this, the floating peek stays open
   * underneath that inline expansion — the same image shown twice, once floating over the text it
   * was supposed to leave uncovered. `hoverDisabled` forces `open` closed (without unmounting, so a
   * `keepMounted` panel's contents survive) and blocks `pointerenter` from reopening it, for as long
   * as the caller says the trigger is already pinned some other way. Default false.
   */
  hoverDisabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  // React's documented "adjust state during render" pattern (not an Effect) for both of these: an
  // Effect version would commit a render with the panel still absent, THEN run and flip the state,
  // THEN re-render — pushing the panel's first mount (and, below, `showPopover()`/anchor wiring) to
  // a second paint. Calling `setState` here instead makes React discard this render and retry
  // immediately with the new value, so `mounted` (below) is already correct on the render where
  // `open` first becomes true. Both are guarded so they only fire on the render where they'd
  // actually change something — otherwise this would be an infinite re-render loop, not a one-time
  // adjustment.
  if (keepMounted && open && !everOpened) setEverOpened(true);
  if (hoverDisabled && open) setOpen(false);

  // Once `keepMounted`, the panel stays in the DOM after the first open — `mounted` tracks "has this
  // ever been open", `open` still tracks "should it be visible right now" (see the `hidden` class
  // below and the effect's own show/hide branch).
  const mounted = keepMounted ? everOpened : open;

  // 렌더당 한 번만 부른다 — className 계산과 아래 effect가 같은 렌더 안에서는 같은 답을 보도록.
  const promotable = supportsPromotion();

  // CSS 커스텀 식별자(`anchor-name`의 값)는 `--`로 시작해야 하고 그 뒤로는 CSS ident 문자만 올 수
  // 있는데, `useId()`는 `:r1a:` 같은 값을 낸다 — `:`가 섞여 있으면 무효한 식별자가 된다. 영숫자만
  // 남긴다.
  const anchorName = `--ip-${id.replace(/[^a-zA-Z0-9]/g, "")}`;

  // 패널은 `open`일 때만 렌더되므로, 이 효과들은 반드시 `[open]`에 걸어야 한다. `[]`로 두면 마운트
  // 시점에 `panelRef.current`가 아직 null이라 리스너가 영영 붙지 않는다. `keepMounted`일 때도
  // `mounted`가 아니라 `open`에 거는 이유는 바로 위 "state during render" 조정 덕분에 `open`이
  // 바뀌는 바로 그 렌더에서 `mounted`도 이미 같은 값으로 바뀌어 있기 때문 — 별도 커밋을 기다릴
  // 필요가 없다.
  useEffect(() => {
    if (!open) return;
    const panelEl = panelRef.current;
    const triggerEl = triggerRef.current;
    if (!panelEl || !triggerEl) return;

    if (promotable) {
      // 이 컴포넌트가 처음 promote되는 순간 한 번만 주입한다 — 여러 인스턴스가 중복으로 넣지
      // 않도록 `PROMOTED_STYLE_ID`로 존재를 먼저 확인하는 것은 `ensurePromotedStylesInjected`
      // 안에서 한다.
      ensurePromotedStylesInjected();

      // `popover` 속성은 promote할 때만 붙인다 — UA 스타일시트가 `[popover]`에는 `:popover-open`
      // 여부와 무관하게 `display: none`을 걸어 두기 때문이다(jsdom 30도 이 부분은 실제로
      // 구현한다 — `showPopover`가 undefined인데도 그렇다). `showPopover()`를 부르지 않을 거면
      // 이 속성 자체를 붙이지 않아야 패널이 (promote되지 않은 채로) 보인다.
      //
      // React 18의 `@types/react`(18.3.31 기준) `HTMLAttributes`에는 `popover`가 없다(canary
      // 타입에만 있다) — JSX 속성으로 쓰면 `pnpm typecheck:web`이 깨진다. 그래서 여기서
      // `setAttribute`로 직접 붙인다.
      panelEl.setAttribute("popover", "manual");

      // 트리거를 anchor로 등록하고, 패널을 그 anchor에 묶는다 — 인스턴스마다 다른 것은 이 이름
      // 뿐이고, 나머지 위치 계산은 전부 `PROMOTED_STYLE_TEXT`의 정적 규칙이 한다(`.ip-panel`/
      // `.ip-panel--left`/`.ip-panel--right` 클래스는 아래 JSX에서 `align`에 따라 붙인다).
      triggerEl.style.setProperty("anchor-name", anchorName);
      panelEl.style.setProperty("position-anchor", anchorName);

      if (!panelEl.matches(":popover-open")) panelEl.showPopover();
    }
    // promotable이 false면 패널은 지금 이 컴포넌트가 원래 그리던 그대로 — 일반
    // `position: absolute` 엘리먼트로, `top-full`+`left-0`/`right-0` 클래스가 트리거 기준으로
    // 올바르게 붙인다. top layer가 아니므로 조상의 `overflow`에 잘릴 수 있지만, 뷰포트 구석에
    // 뜬 채 트리거와 무관한 위치보다는 낫다. 이 경로에는 `flip-inline`도, `tablet` 아래에서의
    // 뷰포트 고정도 없다 — 둘 다 anchor positioning이 있어야 켤 수 있는 기능이다. 그래서 오른쪽
    // 절반의 트리거가 좁은 화면에서 뷰포트 밖으로 나가는 위험은 이 경로에서는 여전히 남는다: CSS만
    // 으로 "이 트리거가 지금 화면 오른쪽 절반에 있는지"를 알 방법이 없고(그걸 알려면 JS로 트리거
    // 위치를 재는 수밖에 없는데, 그러면 열린 팝오버마다 스크롤·리사이즈 리스너가 필요해진다 — 이
    // 파일 맨 위 doc 주석이 그것을 피하려는 이유다), 유일한 완화책은 호출부가 트리거가 오른쪽에
    // 붙어 있다는 것을 이미 아는 채로 `align="right"`를 직접 고르는 것뿐이다(`Tip`의 `align` 문서
    // 참조) — 이 저장소의 새 회귀는 아니고, promote 이전부터 있던 한계이며, 컨트롤러가 이 상태로
    // 두기로 정했다(ResizeObserver 등 JS 계측으로 좇지 않는다).

    // 브라우저가 스스로 닫은 것(Esc 등)을 상태로 되돌려 받는다. 없으면 DOM은 닫혔는데 상태는 열린
    // 채라, 다음 클릭이 "닫기"로 해석돼 한 번 헛돈다. promote되지 않았을 때는 `toggle`이 원천적으로
    // 발생하지 않으니 그냥 무해하다.
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === "closed") setOpen(false);
    };
    panelEl.addEventListener("toggle", onToggle);

    // jsdom에는 popover의 Esc가 없고, 실제 브라우저에서도 `manual` 팝오버는 Esc로 닫히지 않는다.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);

    return () => {
      panelEl.removeEventListener("toggle", onToggle);
      window.removeEventListener("keydown", onKey);
      // 언마운트 순서에 따라 top layer에 남는 것을 막는다.
      if (typeof panelEl.hidePopover === "function" && panelEl.matches(":popover-open")) panelEl.hidePopover();
      // 트리거는 패널과 달리 열림/닫힘에 걸쳐 계속 존재하므로, `anchor-name`을 직접 지워야 다음
      // 오픈까지 스타일에 남아있지 않는다 — 값은 매번 같아서 실질적 차이는 없지만, 패널이 없는
      // 동안 이름 없는 anchor를 자처하고 있을 이유가 없다.
      triggerEl.style.removeProperty("anchor-name");
    };
  }, [open, anchorName, promotable]);

  const fromMouse = (e: { pointerType: string }) => e.pointerType !== "touch";

  return (
    <span
      className={`relative inline-flex ${className ?? ""}`.trim()}
      // The `!hoverDisabled` here does not change the end state on its own — the render-time
      // correction above (`if (hoverDisabled && open) setOpen(false)`) would discard-and-retry any
      // wrongly-`true` value before it ever paints, same as it does when `hoverDisabled` flips on
      // while already open. It is here to skip that wasted extra render pass on every `pointerenter`
      // that fires while disabled, not to fix a case the correction above would otherwise miss.
      //
      // What neither of these fixes: a mouse already resting on the trigger when `hoverDisabled`
      // flips back off (e.g. `MarkerText`'s marker gets un-pinned under a stationary pointer) does
      // not resume the peek on its own — nothing re-fires `pointerenter` just because a sibling's
      // state changed. The pointer has to leave and re-enter. Accepted for `MarkerText`: the common
      // path un-pins by moving the pointer to click something else first anyway.
      onPointerEnter={(e) => !hoverDisabled && fromMouse(e) && setOpen(true)}
      onPointerLeave={(e) => fromMouse(e) && setOpen(false)}
    >
      <span
        // 트리거는 클릭 가능해야 한다 — 터치와 키보드의 유일한 경로다. `children`이 이미 버튼인
        // 경우가 있어 여기서 `<button>`을 겹치지 않고, 래퍼가 클릭을 받는다.
        //
        // 그런데 `children`이 disabled 네이티브 컨트롤이면 클릭이 아예 여기까지 오지 않는다 —
        // 브라우저는 disabled 폼 컨트롤에 대해 click을 "버블시키지 않는" 게 아니라 애초에
        // 발생시키지 않는다(포인터·키보드 둘 다). `Tip`의 주요 용도가 바로 이 경우다: disabled된
        // 컨트롤이 눌리지 않는 이유를 설명하는 카드이므로, disabled가 열리지 않는 경로를 막으면
        // 이 컴포넌트의 존재 이유가 없어진다.
        //
        // `[&_:disabled]:pointer-events-none`이 포인터 쪽을 고친다: disabled 후손에서 hit-test를
        // 꺼버리면 그 자리를 누른 포인터(마우스든 터치든)는 그 아래, 즉 이 래퍼로 떨어진다 — 이제
        // 클릭의 타깃이 이 래퍼 자신이 된다(자식에서 버블된 게 아니라). disabled 버튼에 tooltip을
        // 붙이는 표준적인 우회법과 같다.
        //
        // 키보드 쪽은 CSS로 안 풀린다 — disabled 네이티브 컨트롤은 pointer-events와 무관하게 탭
        // 순서에서 아예 빠진다. 그래서 이 래퍼 자신을 항상 포커스 가능하게 만들고(`tabIndex={0}`)
        // Enter·Space를 직접 받는다(`onKeyDown`). `children`이 이미 활성 상태의 `<button>`이라면
        // 그 버튼 자신도 탭 정지점이라 여기서 하나가 더 생긴다 — 중첩된 상호작용 요소가 생기는
        // 비용이지만, disabled·플레인 `<span>` 배지처럼 자기 탭 정지점이 없는 `children`에서
        // 키보드 경로를 얻으려면 이 래퍼가 무조건 탭 가능해야 한다.
        //
        // `role="button"`은 일부러 안 붙인다 — `children`이 실제 `<button>`이면(disabled여도
        // 접근성 트리에는 남는다) 래퍼에도 role="button"을 붙이는 순간 이름이 같은 버튼 두 개가
        // 생겨 스크린 리더에도, `getByRole("button", { name })`에도 어느 쪽인지 모호해진다 —
        // 실제로 이 저장소의 여러 테스트가 그 중복으로 깨졌다. `tabIndex`+`onKeyDown`만으로도
        // 키보드 조작은 되고, 이 래퍼가 진짜 트리거인 경우(자식이 버튼이 아닌 경우)는 스크린
        // 리더가 `aria-expanded`·`aria-controls`로 그 성격을 여전히 읽는다.
        // `targetsEnabledControl`(모듈 위쪽, Critical 1의 긴 doc 주석 참조)을 클릭·키다운 둘 다에서
        // 먼저 묻는 이유: Task 10이 여덟 개의 *활성* 컨트롤을 이 래퍼로 감싼 뒤에야 드러난 버그다.
        // 이 확인이 없으면 자식에서 버블된 이벤트도 래퍼 자신이 처리해야 할 이벤트와 구별되지
        // 않는다 — 활성 자식(자기 onClick이 있는 진짜 버튼)에서는 래퍼가 손을 떼야 그 자식의 네이티브
        // 클릭·키보드 활성화가 방해 없이 그대로 일어나고, disabled 자식이나 `<span>` 배지처럼 자기
        // 행동이 없는 자식에서는 여전히 이 래퍼가 열고 닫는다.
        onClick={(e) => {
          if (hoverDisabled || targetsEnabledControl(e.target, e.currentTarget)) return;
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (hoverDisabled || targetsEnabledControl(e.target, e.currentTarget)) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          // Space의 기본 동작(페이지 스크롤)을 막는다 — 네이티브 버튼이라면 브라우저가 이미 하는 일.
          e.preventDefault();
          setOpen((v) => !v);
        }}
        ref={triggerRef}
        tabIndex={0}
        aria-expanded={open}
        aria-controls={id}
        className="inline-flex [&_:disabled]:pointer-events-none"
      >
        {children}
      </span>
      {mounted && (
        <div
          ref={panelRef}
          id={id}
          role={role}
          // 위치·anchor·popover 속성은 전부 이 바깥 박스가 진다 — top layer로 promote되는 것도,
          // CSS anchor positioning이 걸리는 것도 이 엘리먼트 자신이다(effect 참조). 시각적으로는
          // 보이지 않는다 — 테두리·배경·그림자는 안쪽 박스가 진다(아래). `pt-1.5`가 트리거와
          // 패널 사이의 여백이다: 예전의 `mt-1.5`(마진)였다면 그 여백은 이 박스 자신의 히트테스트
          // 영역 바깥이었다 — 마우스가 트리거에서 패널로 곧장 내려가다 그 6px 띠를 지나는 순간
          // `pointerleave`가 뜨고 패널이 닫혔다(Critical 2, `PROMOTED_STYLE_TEXT` 위 doc 주석
          // 참조). 패딩은 이 박스 자신의 히트테스트 영역 *안*이라 같은 문제가 없다.
          //
          // `ip-panel`/`ip-panel--left`/`ip-panel--right`는 promote될 때만 뜻이 있다
          // (`PROMOTED_STYLE_TEXT` 참조) — `promotable`이 false인 브라우저에서는 이 클래스에
          // 대응하는 규칙이 애초에 존재하지 않으므로 붙여도 무해하지만, 붙이지 않아 두 경로가 서로
          // 완전히 무관하다는 것을 코드로도 분명히 한다.
          //
          // `keepMounted && !open`의 `hidden`: `mounted`가 `open`과 갈라지는 것은 `keepMounted`뿐이고,
          // 그 경우 패널은 닫혀 있는 동안에도 DOM에 남는다. promote된 경로는 `hidePopover()`(effect
          // 참조)가 UA 스타일시트를 통해 `display: none`을 걸어 주지만, promote되지 않는 브라우저에는
          // 그 자동 숨김이 없다 — `popover` 속성 자체를 붙이지 않기 때문이다(바로 위 주석). 이 클래스가
          // 그 경로를 커버한다. promote된 경로에도 걸리지만 같은 결론(`display: none`)이라 무해하다.
          className={`absolute top-full ${align === "right" ? "right-0" : "left-0"} z-30 pt-1.5 max-w-[calc(100vw-2rem)] ${
            promotable ? `ip-panel ip-panel--${align === "right" ? "right" : "left"}` : ""
          } ${keepMounted && !open ? "hidden" : ""}`.trim()}
        >
          {/*
            안쪽 박스. 보이는 카드 전부 — 테두리·배경·그림자·`panelClassName`(폭·패딩·글자) — 를
            여기서 진다. `promotable`일 때 이 박스에도 `ip-panel`(align 변형 없이 기본 클래스만)을
            얹는 것은 위치 때문이 아니다 — 이 박스는 `position: static`이라 anchor/inset 관련
            프로퍼티는 전부 무시된다. 폭 때문이다: 좁은 화면 미디어쿼리의 `width: auto`가 바깥
            박스뿐 아니라 이 박스의 `panelClassName`발 `w-*`도 같이 덮어써야, `inset-inline`으로
            뷰포트 양끝에 고정된 바깥 박스를 이 박스가 실제로 채운다 — 안 그러면 바깥은 넓어지는데
            보이는 카드는 원래 폭(`w-64`/`w-72`/`w-80`)에 그대로 남는다.
          */}
          <div
            className={`rounded-lg border border-line bg-surface shadow-lg max-w-[calc(100vw-2rem)] ${
              promotable ? "ip-panel" : ""
            } ${panelClassName ?? ""}`.trim()}
          >
            {panel}
          </div>
        </div>
      )}
    </span>
  );
}
