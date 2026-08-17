import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * 보드의 호버 카드 idiom 하나. `group` + `absolute top-full` + `hidden … group-hover:block`으로
 * 손으로 쓰던 네 곳(`App.tsx`의 스토리지 패널, `CollectedBreakdownCard`, `Tip`, `OpenLink`)이 여기로
 * 모인다. `MarkerText`는 이 목록에 없다 — Task 5가 그것을 인라인 아코디언으로 바꾼다. 팝오버는
 * 정확히 그것이 설명하는 텍스트를 덮어버리기 때문이다.
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
 * 않는다(아래 `canPromote` 참조) — JS로 좌표를 계산하는 대신인 이유는 그러면 스크롤·리사이즈
 * 리스너가 열린 팝오버마다 필요해지는데, anchor positioning은 그 두 경우 모두 공짜로 따라오기
 * 때문이다.
 *
 * `position-area`가 아니라 저수준 `anchor()` 함수로 4변을 직접 쓰는 이유: `position-area`(예:
 * `bottom span-left`)의 기본 self-alignment가 실제 Chromium(버전 150)에서 한쪽 방향
 * (`align="left"`, 트리거 왼쪽 경계에서 오른쪽으로)은 맞게 나오지만 반대 방향(`align="right"`,
 * 트리거 오른쪽 경계에서 왼쪽으로)은 재현 가능하게 틀렸다 — 뷰포트 왼쪽 끝에 들러붙는다.
 * `justify-self: end`도, `position-try-fallbacks: none`도, 충돌하는 inset을 미리 지우는 것도
 * 고치지 못했다. `anchor()`는 양쪽 방향 모두 정확했다(격리된 재현과 스크린샷은 task-3-report.md
 * 참조). 네 변을 먼저 전부 `auto`로 미는 이유는 아래 `canPromote` 블록의 주석에 있다.
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
export function InfoPopover({
  panel,
  align = "left",
  className,
  panelClassName,
  role,
  children,
}: {
  panel: ReactNode;
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
  role?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  // CSS 커스텀 식별자(`anchor-name`의 값)는 `--`로 시작해야 하고 그 뒤로는 CSS ident 문자만 올 수
  // 있는데, `useId()`는 `:r1a:` 같은 값을 낸다 — `:`가 섞여 있으면 무효한 식별자가 된다. 영숫자만
  // 남긴다.
  const anchorName = `--ip-${id.replace(/[^a-zA-Z0-9]/g, "")}`;

  // 패널은 `open`일 때만 렌더되므로, 이 효과들은 반드시 `[open]`에 걸어야 한다. `[]`로 두면 마운트
  // 시점에 `panelRef.current`가 아직 null이라 리스너가 영영 붙지 않는다.
  useEffect(() => {
    if (!open) return;
    const panelEl = panelRef.current;
    const triggerEl = triggerRef.current;
    if (!panelEl || !triggerEl) return;

    // top layer로 올려도 되는지: `showPopover`가 있어야 하고(1단계 향상), CSS Anchor Positioning도
    // 지원해야 한다(2단계 향상 — 위 doc 주석의 containing block 문제 참조). `CSS.supports`가 없는
    // 환경(구형 브라우저, `CSS` 자체가 없는 환경)도 방어한다.
    const canPromote =
      typeof panelEl.showPopover === "function" &&
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("anchor-name: --x");

    if (canPromote) {
      // `popover` 속성은 promote할 때만 붙인다 — UA 스타일시트가 `[popover]`에는 `:popover-open`
      // 여부와 무관하게 `display: none`을 걸어 두기 때문이다(jsdom 30도 이 부분은 실제로
      // 구현한다 — `showPopover`가 undefined인데도 그렇다). `showPopover()`를 부르지 않을 거면
      // 이 속성 자체를 붙이지 않아야 패널이 (promote되지 않은 채로) 보인다.
      //
      // React 18의 `@types/react`(18.3.31 기준) `HTMLAttributes`에는 `popover`가 없다(canary
      // 타입에만 있다) — JSX 속성으로 쓰면 `pnpm typecheck:web`이 깨진다. 그래서 여기서
      // `setAttribute`로 직접 붙인다.
      panelEl.setAttribute("popover", "manual");

      // 트리거를 anchor로 등록하고, 패널을 그 anchor에 묶는다.
      triggerEl.style.setProperty("anchor-name", anchorName);
      panelEl.style.setProperty("position-anchor", anchorName);

      // `position-area`가 아니라 `anchor()` 함수로 직접 4변을 지정한다 — `position-area`(예:
      // `bottom span-left`)로 시도했을 때 "왼쪽 경계 정렬"(`align="left"`, 기본값) 방향은 맞게
      // 나오지만 "오른쪽 경계 정렬"(`align="right"`) 방향은 실제 Chromium(버전 150)에서 재현
      // 가능하게 틀렸다 — `justify-self: end`도, `position-try-fallbacks: none`도 고치지 못했다.
      // `anchor()`는 두 방향 모두 정확했다(task-3-report.md의 격리된 재현 참조).
      //
      // 아래 세 줄(top이 아닌 나머지 셋 + margin)을 먼저 `auto`/`0`으로 미는 이유: `[popover]`의
      // UA 스타일시트 기본값이 `inset: 0`이다 — `top`/`right`/`bottom`/`left` 네 개가 전부 `auto`가
      // 아니라 명시적으로 `0`이다. 패널의 `width`는 (Tailwind의 `w-72`/`w-80`/`w-64` 등으로)
      // 확정값이므로, 예를 들어 `right`만 anchor 기준으로 설정해도 `left`가 여전히 UA의 `0`으로
      // 남아 있으면 "확정 너비 + 확정 left + 확정 right"로 과확정(over-constrained)된다 — CSS 2.1의
      // 해소 규칙상 LTR에서는 이럴 때 `right`가 무시되고 `left: 0`이 이긴다. 그래서 뷰포트 좌측에
      // 계속 들러붙어 있었다. `height`는 확정값이 없어(`auto`) 문제가 되지 않지만(과확정 규칙은
      // `top`+`bottom`이 모두 있고 `height`도 확정일 때만 발동), 대칭성과 안전을 위해 `bottom`도
      // 함께 지운다. `top`은 지우자마자 바로 실제 값으로 덮으므로 `auto`를 거치지 않는다.
      panelEl.style.setProperty("right", "auto");
      panelEl.style.setProperty("bottom", "auto");
      panelEl.style.setProperty("left", "auto");
      panelEl.style.setProperty("margin", "0");

      // `0.375rem`은 Tailwind `mt-1.5`와 같은 값 — promote되지 않았을 때의 간격을 그대로 유지한다.
      // `calc(anchor(...))`로 감싸는 이유는 값 자체가 아니라(단일 값의 `calc()`는 수학적으로
      // no-op이다) jsdom의 CSSOM(`cssstyle`)이 `top`/`right`처럼 알려진 프로퍼티에 `anchor()`를
      // 감싸지 않은 채로 주면 `setProperty`를 조용히 무시하기 때문이다 — `calc()` 안에서는
      // 받아들인다. 이 저장소의 InfoPopover 테스트가 그 값을 읽으려면 필요하다.
      panelEl.style.setProperty("top", `calc(anchor(${anchorName} bottom) + 0.375rem)`);
      panelEl.style.setProperty(
        align === "right" ? "right" : "left",
        `calc(anchor(${anchorName} ${align === "right" ? "right" : "left"}))`,
      );

      // 헤더 오른쪽 절반에 가까운 트리거는 `align="left"`(기본값)로도 패널이 뷰포트 오른쪽 밖으로
      // 나갈 수 있다 — `max-w-[calc(100vw-2rem)]`는 패널의 *너비*만 뷰포트에 맞춰 줄일 뿐, 트리거
      // 기준의 *오프셋*은 그대로이기 때문이다(390px처럼 좁은 화면일수록 실제로 벌어진다). `anchor()`도
      // `position-area`도 스스로 뒤집지는 않으므로, `flip-inline`으로 인라인 축(왼쪽/오른쪽)이
      // 넘칠 때만 자동으로 반대쪽 정렬을 시도하게 한다 — 커스텀 `@position-try` 블록이 아니라
      // 내장 키워드를 쓰는 이유는 Safari가 전자는 18.4+에서야, 후자는 18.2+에서 지원해서다(둘 다
      // `CSS.supports("anchor-name: ...")` 한 줄로는 구분되지 않는 차이지만, 내장 키워드 쪽이 더
      // 넓게 지원되므로 그쪽을 쓴다). 실제 Chromium 390px 창에서 오른쪽 절반의 트리거로 측정
      // 확인함 — task-3-report.md 참조.
      panelEl.style.setProperty("position-try-fallbacks", "flip-inline");

      if (!panelEl.matches(":popover-open")) panelEl.showPopover();
    }
    // canPromote가 false면 패널은 지금 이 컴포넌트가 원래 그리던 그대로 — 일반
    // `position: absolute` 엘리먼트로, `top-full`+`left-0`/`right-0` 클래스가 트리거 기준으로
    // 올바르게 붙인다. top layer가 아니므로 조상의 `overflow`에 잘릴 수 있지만, 뷰포트 구석에
    // 뜬 채 트리거와 무관한 위치보다는 낫다. 이 경로에는 `flip-inline`과 같은 뒤집기가 없다 —
    // anchor positioning 자체가 없는 브라우저에서 켤 수 있는 기능이 아니다. 그래서 오른쪽 절반의
    // 트리거가 좁은 화면에서 뷰포트 밖으로 나가는 위험은 이 경로에서는 여전히 남는다: CSS만으로
    // "이 트리거가 지금 화면 오른쪽 절반에 있는지"를 알 방법이 없고(그걸 알려면 JS로 트리거 위치를
    // 재는 수밖에 없는데, 그러면 열린 팝오버마다 스크롤·리사이즈 리스너가 필요해진다 — 이 파일
    // 맨 위 doc 주석이 그것을 피하려는 이유다), 유일한 완화책은 호출부가 트리거가 오른쪽에
    // 붙어 있다는 것을 이미 아는 채로 `align="right"`를 직접 고르는 것뿐이다(`Tip`의 `align` 문서
    // 참조) — 이 저장소의 새 회귀는 아니고, promote 이전부터 있던 한계다.

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
  }, [open, align, anchorName]);

  const fromMouse = (e: { pointerType: string }) => e.pointerType !== "touch";

  return (
    <span
      className={`relative inline-flex ${className ?? ""}`.trim()}
      onPointerEnter={(e) => fromMouse(e) && setOpen(true)}
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
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
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
      {open && (
        <div
          ref={panelRef}
          id={id}
          role={role}
          className={`absolute top-full ${align === "right" ? "right-0" : "left-0"} z-30 mt-1.5 block max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface shadow-lg ${panelClassName ?? ""}`.trim()}
        >
          {panel}
        </div>
      )}
    </span>
  );
}
