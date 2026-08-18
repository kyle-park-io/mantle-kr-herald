import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 1차 검수와 2차 검수가 함께 쓰는 목록+상세 셸.
 *
 * 두 곳(`App.tsx`, `RenderingsView.tsx`)에 같은 구조가 복제돼 있었고, 드로우를 각각 넣으면 그
 * 로직도 두 벌이 된다 — `buttonStyles.ts` 헤더 주석이 경고하는 바로 그 상황이다. 한 벌로 두면 2차가
 * 1차와 다르게 동작할 수가 없다.
 *
 * 폰에서는 `aside`가 화면 밖에 대기하는 시트가 되고, 태블릿(48rem) 이상에서는 그냥 컬럼이다. 중요한
 * 것은 **트리에 하나만 둔다**는 점이다: 폭에 따라 다른 요소를 렌더하면 창 크기를 바꿀 때마다
 * 리마운트되어 목록의 스크롤 위치와 `SearchBox`의 검색어가 날아간다. 역할만 CSS로 바꾼다.
 *
 * 네이티브 `popover`를 쓰지 않는 이유: `popover`는 HTML 속성이고 열리기 전에는 `display:none`인데,
 * 태블릿 이상에서 이 `aside`는 팝오버가 아니라 정상적인 레이아웃 컬럼이어야 한다. CSS로는 속성을 뗄
 * 수 없으므로 JS로 폭을 보며 붙였다 뗐다 하거나 `aside`를 두 벌 렌더해야 하고, 둘 다 더 나쁘다.
 *
 * 닫는 경로는 넷이다 — Esc, 백드롭 클릭, 드로우 자신의 닫기 버튼, 그리고 목록에서 항목을 고르는 것.
 * 마지막 것은 `current`를 지켜보는 대신 **클릭이 `aside` 밖으로 버블링되기 전에 `li` 안의
 * `button`/`a`에서 시작됐는지**를 본다 — `current` 변화를 지켜보면 "이미 고른 항목을 다시 누른다"에서
 * `current`가 안 바뀌므로 드로우가 안 닫힌다(실제 버그였다). 필터 탭과 검색창의 지우기 버튼은
 * `aside`의 헤더 안에 있고 `li`로 감싸이지 않으므로, 이 규칙은 그것들을 건드리지 않는다 — 목록
 * 컴포넌트가 행마다 `<li><button>…</button></li>`를 쓴다는 관례에만 기대고, 선택 콜백은 여전히
 * 모른다.
 *
 * ☰는 이제 열기 전용이다. 열린 뒤에는 `aside`(w-80, 320px 안팎)와 백드롭이 그 위에 그려져서 같은
 * 자리를 다시 눌러도 드로우에 가로막히므로, 라벨이 "목록 닫기"로 바뀌어봤자 그 상태에 도달할 방법이
 * 없다 — 도달 못 하는 상태를 광고하는 라벨은 없느니만 못하다. 닫기는 `aside` 자신의 헤더에 있는
 * 별도 버튼이 맡는다. ☰를 오른쪽 끝(폰 바가 `max-w-[85vw]` 덕에 남기는 좁은 띠)으로 옮기는 대신
 * 이 방법을 택한 이유: 390px 화면에서 그 띠는 44px 터치 타깃을 겨우 담을 58px 정도이고, 더 좁은
 * 폰에서는 그마저 못 담는다.
 *
 * 포커스는 열릴 때 드로우 안(닫기 버튼)으로 들어가고, 닫힐 때(경로에 상관없이) ☰로 돌아온다 —
 * `aside`는 `-translate-x-full`일 뿐 `display:none`이 아니라서 포커스를 옮기지 않으면 화면 밖의
 * 버튼에 포커스가 남는다. 포커스 트랩이나 `role="dialog"`/`aria-modal`은 의도적으로 넣지 않았다 —
 * 폭에 따라 붙였다 뗐다 해야 하는 속성이라 이 컴포넌트가 `popover`를 쓰지 않는 이유와 같은 함정이고,
 * Esc로 닫는 경로가 이미 있다. 나중의 접근성 개편에 남겨둔다.
 */
export function ListDetailShell({
  list,
  detail,
  current,
}: {
  list: ReactNode;
  detail: ReactNode;
  current?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 열릴 때 닫기 버튼으로, 닫힐 때 ☰로. 마운트 시점(둘 다 처음엔 false)에는 건드리지 않는다 — 열린
  // 적이 없으니 되돌아갈 곳도 없다. `previous`와 같은 이유로 ref로 전이를 감지한다: state로 하면
  // 렌더가 한 번 더 돈다.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      closeRef.current?.focus();
    } else if (!open && wasOpen.current) {
      triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  // 선택으로 인한 닫힘 — 위 파일 헤더 주석 참고. `li` 안의 인터랙티브 요소에서 시작된 클릭만 본다.
  const onAsideClick = (e: React.MouseEvent<HTMLElement>) => {
    const control = (e.target as HTMLElement).closest("button, a");
    if (control && control.closest("li")) setOpen(false);
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* 백드롭. 폰에서 드로우가 열렸을 때만 존재한다. */}
      {open && (
        <div
          data-testid="drawer-backdrop"
          className="fixed inset-0 z-30 bg-ink/30 tablet:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        onClick={onAsideClick}
        className={`fixed inset-y-0 left-0 z-40 flex w-80 max-w-[85vw] flex-col border-r border-line bg-surface transition-transform tablet:static tablet:z-auto tablet:max-w-none tablet:translate-x-0 tablet:transition-none ${
          open ? "translate-x-0" : "-translate-x-full"
        } tablet:shrink-0`}
      >
        {/* 드로우 자신의 헤더. 태블릿 이상에서는 숨는다 — 그 폭에서는 `aside`가 이미 평범한 컬럼이라
            닫을 것이 없다. */}
        <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-3 py-2 tablet:hidden">
          <span className="text-[13px] font-medium text-muted">목록</span>
          {/* 테두리 없이 글리프만 — 히트 영역은 44x44로 유지하되(손가락이 닿아야 하니까),
              보이는 무게는 옆의 작은 `목록` 라벨에 맞춘다. 테두리를 두르면 이 작은 헤더에서
              닫기 버튼이 제목보다 무거워 보인다. */}
          <button
            type="button"
            ref={closeRef}
            onClick={() => setOpen(false)}
            aria-label="목록 닫기"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[18px] leading-none text-muted transition-colors hover:bg-bg hover:text-ink"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">{list}</div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {/* 폰 전용 바. ☰가 헤더가 아니라 여기 있는 이유는 두 가지다. 헤더에 두면 드로우 상태를
            `App`까지 올려 `RenderingsView`에도 내려보내야 하는데, 셸이 자기 트리거를 직접 들면 그
            배선이 아예 없다. 그리고 드로우가 닫히면 목록의 하이라이트가 안 보이므로, 폰에는 "지금
            무엇을 보고 있는지" 적을 자리가 따로 필요하다. */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line bg-surface px-4 py-2 tablet:hidden">
          <button
            type="button"
            ref={triggerRef}
            onClick={() => setOpen(true)}
            aria-expanded={open}
            aria-label="목록 열기"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line-strong bg-surface text-[15px] text-ink"
          >
            ☰
          </button>
          <span data-testid="current-item" className="truncate text-[13px] font-medium text-muted">
            {current ?? "목록에서 고르세요"}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">{detail}</div>
      </section>
    </div>
  );
}
