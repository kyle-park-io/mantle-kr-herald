import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * 보드의 호버 카드 idiom 하나. `group` + `absolute top-full` + `hidden … group-hover:block`으로
 * 손으로 쓰던 다섯 곳(`App.tsx`의 스토리지 패널, `CollectedBreakdownCard`, `MarkerText`, `Tip`,
 * `OpenLink`)이 여기로 모인다.
 *
 * 왜 호버만으로는 안 되는가: Tailwind v4는 `hover:`를 `@media (hover: hover)`로 감싸 내보내므로
 * 터치 기기에서는 확정적으로 열리지 않는다. 그리고 그것은 모바일만의 문제가 아니다 — 호버가
 * 유일한 경로인 카드는 데스크톱에서 키보드로도 볼 수 없다.
 *
 * 왜 네이티브 `popover`인가: 패널이 top layer로 올라가 조상의 `overflow`에 잘릴 수 없게 된다.
 * `App.tsx`가 헤더에 `overflow-x-auto`를 못 쓰는 이유가 정확히 그 잘림이었다(그 파일의 주석
 * 참조). Esc와 바깥 클릭 닫기도 브라우저가 해준다.
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
  const id = useId();

  // 패널은 `open`일 때만 렌더되므로, 이 효과들은 반드시 `[open]`에 걸어야 한다. `[]`로 두면 마운트
  // 시점에 `panelRef.current`가 아직 null이라 리스너가 영영 붙지 않는다.
  useEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (!el) return;

    // `popover` 속성: React 18의 `@types/react`(18.3.31 기준) `HTMLAttributes`에는 `popover`가
    // 없다(canary 타입에만 있다) — JSX 속성으로 쓰면 `pnpm typecheck:web`이 깨진다. 그래서 여기서
    // `setAttribute`로 직접 붙인다. 실제 브라우저에서는 이 속성이 있어야 `showPopover()`가 동작한다.
    el.setAttribute("popover", "manual");

    // 네이티브 popover가 있는 브라우저에서만 top layer로 올린다. jsdom에서는 `showPopover`가
    // undefined이므로 이 줄을 건너뛰고, 패널은 아래 클래스만으로 보인다 — 양쪽 다 동작한다.
    if (typeof el.showPopover === "function" && !el.matches(":popover-open")) el.showPopover();

    // 브라우저가 스스로 닫은 것(Esc 등)을 상태로 되돌려 받는다. 없으면 DOM은 닫혔는데 상태는 열린
    // 채라, 다음 클릭이 "닫기"로 해석돼 한 번 헛돈다.
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === "closed") setOpen(false);
    };
    el.addEventListener("toggle", onToggle);

    // jsdom에는 popover의 Esc가 없고, 실제 브라우저에서도 `manual` 팝오버는 Esc로 닫히지 않는다.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);

    return () => {
      el.removeEventListener("toggle", onToggle);
      window.removeEventListener("keydown", onKey);
      // 언마운트 순서에 따라 top layer에 남는 것을 막는다.
      if (typeof el.hidePopover === "function" && el.matches(":popover-open")) el.hidePopover();
    };
  }, [open]);

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
