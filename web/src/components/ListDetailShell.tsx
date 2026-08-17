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
  // 고른 것이 바뀌면 닫는다. 셸은 선택을 모르지만, 선택은 곧 `current`의 변화다. 첫 렌더에서는
  // 닫지 않는다 — 이미 닫혀 있고, 여기서 상태를 건드리면 불필요한 렌더가 한 번 더 돈다.
  const previous = useRef(current);
  useEffect(() => {
    if (previous.current !== current) {
      previous.current = current;
      setOpen(false);
    }
  }, [current]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="flex min-h-0 flex-1">
      {/* 백드롭. 폰에서 드로우가 열렸을 때만 존재한다. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-ink/30 tablet:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-80 max-w-[85vw] overflow-y-auto border-r border-line bg-surface transition-transform [scrollbar-gutter:stable] tablet:static tablet:z-auto tablet:max-w-none tablet:translate-x-0 tablet:transition-none ${
          open ? "translate-x-0" : "-translate-x-full"
        } tablet:shrink-0`}
      >
        {list}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {/* 폰 전용 바. ☰가 헤더가 아니라 여기 있는 이유는 두 가지다. 헤더에 두면 드로우 상태를
            `App`까지 올려 `RenderingsView`에도 내려보내야 하는데, 셸이 자기 트리거를 직접 들면 그
            배선이 아예 없다. 그리고 드로우가 닫히면 목록의 하이라이트가 안 보이므로, 폰에는 "지금
            무엇을 보고 있는지" 적을 자리가 따로 필요하다. */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line bg-surface px-4 py-2 tablet:hidden">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "목록 닫기" : "목록 열기"}
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
