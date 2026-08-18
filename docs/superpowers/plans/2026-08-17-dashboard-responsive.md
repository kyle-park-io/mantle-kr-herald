# 대시보드 태블릿·모바일 대응 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 검수 대시보드를 폰·태블릿에서 전부 쓸 수 있게 한다 — 읽기·편집·저장·승인·발송·발행 전부, 화면 폭에 따라 능력을 빼지 않고.

**Architecture:** 내용 영역(`max-w-3xl` 한 컬럼)은 이미 폰 모양이라 손대지 않는다. 고치는 것은 그것을 감싼 2단 셸(두 벌 → 한 벌로 합치고 폰에서 드로우로), 터치에서 도달할 수 없는 호버 전용 정보(네이티브 `popover` 위에 React 상태를 주인으로 얹어서), 그리고 손가락에 작은 버튼(`pointer-coarse` 한 줄)이다. 뷰포트 경계는 `tablet: 48rem` 하나뿐이고, 컴포넌트 내부 분기는 컨테이너 쿼리가 맡는다.

**Tech Stack:** React 18, Vite 5, Tailwind CSS 4.3.2 (`@theme` CSS-first), Vitest 2 + jsdom 30 + Testing Library, Playwright(MCP)

**Spec:** `docs/superpowers/specs/2026-08-17-dashboard-responsive-design.md`

## Global Constraints

- **뷰포트 브레이크포인트는 `tablet: 48rem`(768px) 하나뿐.** `@theme`에서 `--breakpoint-*: initial`로 기본 스케일을 버리고 이것만 정의한다. 새 브레이크포인트를 임의로 추가하지 않는다.
- **브레이크포인트 단위는 반드시 `rem`.** px를 섞으면 생성된 유틸리티 정렬이 어긋나 분기끼리 서로를 덮어쓴다.
- **분기는 선언 지점에 co-locate한다.** `styles.css`에 `@media` 블록을 새로 만들지 않는다. `styles.css`에 들어가는 것은 `@theme` 토큰과 전역 base 규칙뿐이다.
- **셸만 뷰포트 쿼리(`tablet:`)를 쓴다.** 컴포넌트 내부 분기는 `@container`를 쓴다.
- **입력 장치 분기는 `pointer-coarse:`로 통일한다.** `@custom-variant`로 `hover: none`을 새로 만들지 않는다.
- **화면 폭으로 기능을 막지 않는다.** "좁으면 읽기 전용" 같은 분기를 만들지 않는다.
- **`max-w-3xl`·`max-w-sm`·`max-w-lg`는 `--container-*` 스케일이라 초기화에 걸리지 않는다.** 건드리지 않는다.
- **세이프 에어리어와 `viewport-fit=cover`는 넣지 않는다.**
- 회귀 가드: 모든 태스크는 `pnpm test`와 `pnpm typecheck:web`이 통과한 상태로 끝난다.
- web 테스트 파일은 첫 줄에 `// @vitest-environment jsdom`을 둔다(이 저장소의 기존 관례, 전역 setup 파일 없음).

---

### Task 1: 브레이크포인트 축과 전역 base 규칙

`@theme`에 경계 하나를 세우고, 기존 네 곳을 개명하고, 한국어 줄바꿈과 `dvh`를 넣는다.

**Files:**
- Modify: `web/src/styles.css:4-31` (`@theme`), `:33-64` (`@layer base`)
- Modify: `web/src/App.tsx:239` (`h-screen` → `h-dvh`), `:404` (`md:flex` → `tablet:flex`)
- Modify: `web/src/components/TranslationDetail.tsx:155` (`sm:p-8` → `tablet:p-8`)
- Modify: `web/src/components/OutletBoard.tsx:169`, `:200` (`sm:p-8` → `tablet:p-8`)
- Test: `web/tests/breakpointVocabulary.test.ts` (신규)

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `tablet:` 변형이 모든 후속 태스크에서 쓸 수 있게 된다. 값은 48rem = 768px.

- [ ] **Step 1: 실패하는 가드 테스트를 쓴다**

`md:`/`sm:` 같은 기본 스케일 변형이 되살아나는 것을 막는 가드다. `--breakpoint-*: initial` 뒤에는 그 변형들이 **CSS를 아예 생성하지 않으므로**, 실수로 쓰면 조용히 무시된다 — 눈으로는 안 잡히고 테스트로만 잡힌다.

`web/tests/breakpointVocabulary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `styles.css`가 `--breakpoint-*: initial`로 기본 스케일을 버렸으므로, `sm:`/`md:`/`lg:`/`xl:`는
 * 이제 존재하지 않는 변형이다. Tailwind는 모르는 변형을 오류로 만들지 않고 그냥 아무 CSS도 만들지
 * 않기 때문에, 되살아난 `md:flex` 한 줄은 화면에서만 틀리고 빌드는 성공한다. 이 테스트가 그
 * 조용한 실패를 잡는 유일한 자리다.
 */
const SRC = join(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("브레이크포인트 어휘", () => {
  it("기본 스케일 변형(sm:/md:/lg:/xl:/2xl:)을 쓰지 않는다", () => {
    const offenders: string[] = [];
    for (const path of walk(SRC).filter((p) => p.endsWith(".tsx") || p.endsWith(".ts"))) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // className 안의 변형만 본다. `max-w-sm`·`text-sm`은 접두 변형이 아니므로 경계로 배제.
          if (/(?:^|[\s"'`])(?:sm|md|lg|xl|2xl):/.test(line)) {
            offenders.push(`${path.replace(SRC, "web/src")}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("tablet 브레이크포인트가 rem으로 정의돼 있다", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).toMatch(/--breakpoint-\*:\s*initial/);
    expect(css).toMatch(/--breakpoint-tablet:\s*48rem/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run web/tests/breakpointVocabulary.test.ts`
Expected: FAIL — 첫 테스트가 `App.tsx:404`, `TranslationDetail.tsx:155`, `OutletBoard.tsx:169`, `OutletBoard.tsx:200` 네 곳을 offender로 뱉고, 둘째 테스트는 `--breakpoint-tablet`이 없어 실패.

- [ ] **Step 3: `@theme`에 경계를 세운다**

`web/src/styles.css`의 `@theme` 블록 안, `--font-mono` 줄 바로 아래에 넣는다:

```css
  /* 이 앱의 유일한 뷰포트 경계 — 셸이 1단(드로우) → 2단(고정 사이드바)이 되는 곳이고, 헤더의
     퍼널·시트 링크·sync 칩이 돌아오는 곳도 같은 지점이다. 기본 sm/md/lg 스케일은 버린다: 이름에
     뜻이 없으면 "왜 이 경계인가"를 코드가 말해줄 수 없고, 쓰지도 않을 다섯 개가 어휘에 남는다.
     단위는 반드시 rem — Tailwind 기본값이 rem이라 px를 섞으면 생성된 유틸리티의 정렬 순서가
     어긋나 분기끼리 서로를 덮어쓴다. */
  --breakpoint-*: initial;
  --breakpoint-tablet: 48rem; /* 768px */
```

- [ ] **Step 4: 전역 base 규칙을 넣는다**

`web/src/styles.css`의 `@layer base` 안, 기존 `body` 규칙에 두 줄을 더한다:

```css
  body {
    background: var(--color-bg);
    color: var(--color-ink);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    /* 한국어는 어절 단위로 끊겨야 읽힌다. `keep-all`이 단어 안에서 끊는 것을 막고,
       `break-word`가 끊을 데 없는 긴 토큰(URL, 아이디)의 넘침을 막는다. 둘은 짝이어야 한다 —
       `keep-all`만 두면 60자짜리 CDN url이 컨테이너를 뚫고 나간다. */
    word-break: keep-all;
    overflow-wrap: break-word;
  }
```

- [ ] **Step 5: 네 곳을 개명하고 `h-dvh`로 바꾼다**

- `web/src/App.tsx:239`: `className="flex h-screen flex-col bg-bg text-ink"` → `className="flex h-dvh flex-col bg-bg text-ink"`
- `web/src/App.tsx:404`: `className="hidden items-center gap-3 md:flex"` → `className="hidden items-center gap-3 tablet:flex"`
- `web/src/App.tsx:401`의 주석 안 `hidden md:flex` 문자열도 `hidden tablet:flex`로 고친다 (주석이 코드와 어긋나면 안 된다)
- `web/src/components/TranslationDetail.tsx:155`: `className="mx-auto max-w-3xl p-6 sm:p-8"` → `... p-6 tablet:p-8"`
- `web/src/components/OutletBoard.tsx:169`: `className="p-6 text-[13px] text-faint sm:p-8"` → `... tablet:p-8"`
- `web/src/components/OutletBoard.tsx:200`: `className="mx-auto max-w-3xl p-6 sm:p-8"` → `... p-6 tablet:p-8"`

`h-dvh`인 이유: `h-screen`은 `100vh`이고, 모바일 브라우저의 `100vh`는 주소창이 접힌 상태의 높이라 주소창이 보일 때 화면 아래가 잘린다. `dvh`는 현재 실제 높이를 따라간다.

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run web/tests/breakpointVocabulary.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: 전체 회귀와 타입을 확인한다**

Run: `pnpm typecheck:web && pnpm test`
Expected: 둘 다 통과. 기존 web 테스트는 이 클래스들을 단정하지 않으므로 영향이 없어야 한다.

- [ ] **Step 8: 브라우저에서 실제로 생성됐는지 확인한다**

Run: `pnpm dev:web` 을 띄우고 브라우저에서 `/`를 연다. DevTools에서 헤더 우측 그룹(`App.tsx:404`)이 768px 이상에서 보이고 767px에서 사라지는지 확인한다.

이 단계가 필요한 이유: `--breakpoint-*: initial`이 잘못 들어가면 `tablet:` 도 생성되지 않는데, 그 경우 위 테스트는 통과하고(문자열은 맞으니까) 화면만 조용히 틀린다.

- [ ] **Step 9: 커밋**

```bash
git add web/src/styles.css web/src/App.tsx web/src/components/TranslationDetail.tsx \
        web/src/components/OutletBoard.tsx web/tests/breakpointVocabulary.test.ts
git commit -m "feat(web): give the dashboard one named breakpoint, and Korean line breaking"
```

---

### Task 2: `Tip`을 popover 기반으로 — 호버 카드 열 곳이 따라온다

`Tip`(`ConfirmDialog.tsx:177-208`)은 이미 호출처 열 곳을 먹고 있고 API가 `text: string | undefined`로 좁다. 내부만 바꾸면 호출처를 한 줄도 안 고치고 전부 터치·키보드에서 열린다.

**Files:**
- Create: `web/src/components/InfoPopover.tsx`
- Modify: `web/src/components/ConfirmDialog.tsx:177-208` (`Tip`이 `InfoPopover`를 쓰도록)
- Test: `web/tests/InfoPopover.test.tsx` (신규)

**Interfaces:**
- Consumes: Task 1의 `tablet:` (여기서는 안 쓰지만 같은 어휘)
- Produces:
  - `InfoPopover({ panel, align?, className?, panelClassName?, children }): JSX.Element`
    - `panel: React.ReactNode` — 카드 안에 들어갈 내용
    - `align?: "left" | "right"` (기본 `"left"`)
    - `className?: string` — 트리거 래퍼에 붙는다
    - `panelClassName?: string` — 카드에 붙는다 (폭·패딩을 호출처가 정한다)
    - `children: React.ReactNode` — 트리거
  - `Tip`의 공개 API는 그대로: `Tip({ text, className?, align?, children })`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`web/tests/InfoPopover.test.tsx`:

```tsx
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
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run web/tests/InfoPopover.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/InfoPopover"`

- [ ] **Step 3: `InfoPopover`를 구현한다**

`web/src/components/InfoPopover.tsx`:

```tsx
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
 */
export function InfoPopover({
  panel,
  align = "left",
  className,
  panelClassName,
  children,
}: {
  panel: ReactNode;
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
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
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className="inline-flex"
      >
        {children}
      </span>
      {open && (
        <div
          ref={panelRef}
          id={id}
          popover="manual"
          role="tooltip"
          className={`absolute top-full ${align === "right" ? "right-0" : "left-0"} z-30 mt-1.5 block max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface shadow-lg ${panelClassName ?? ""}`.trim()}
        >
          {panel}
        </div>
      )}
    </span>
  );
}
```

`popover="manual"`인 이유: `auto`는 브라우저의 light-dismiss를 켜는데, 그러면 트리거 클릭이 "바깥 클릭"으로 먼저 처리돼 열자마자 닫히는 경합이 생긴다. `manual`은 열고 닫는 것을 이 컴포넌트가 전적으로 책임지므로 상태와 DOM이 어긋날 수 없다. 대신 바깥 클릭 닫기를 잃는데, Esc와 트리거 재클릭이 남고 `pointerLeave`가 마우스 경로를 덮는다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run web/tests/InfoPopover.test.tsx`
Expected: PASS (6 tests)

이 저장소는 React 18이고, popover 속성에 대한 1급 지원은 React 19에서 들어왔다. React 18은 모르는 소문자 속성을 그대로 DOM에 넘기므로 `popover="manual"`은 렌더되지만, **실제로 그런지 눈으로 확인한다** — Task 3 Step 7의 브라우저 확인에서 요소를 검사해 `popover` 속성이 붙어 있고 패널이 top layer에 있는지(헤더 밖으로 넘쳐도 잘리지 않는지) 본다. 만약 React 18이 속성을 떨어뜨린다면 `useEffect`에서 `el.setAttribute("popover", "manual")`로 직접 붙인다.

- [ ] **Step 5: `Tip`이 `InfoPopover`를 쓰게 한다**

`web/src/components/ConfirmDialog.tsx`의 `Tip` 본문(현재 `:197-207`)을 교체한다. 상단 import에 추가:

```tsx
import { InfoPopover } from "./InfoPopover";
```

본문:

```tsx
  if (text === undefined) return <>{children}</>;
  return (
    <InfoPopover
      align={align}
      className={className}
      panelClassName="w-64 px-3 py-2 text-[12px] font-normal leading-relaxed text-muted"
      panel={text}
    >
      {children}
    </InfoPopover>
  );
```

`Tip`의 기존 doc 주석(`:157-176`)은 그대로 둔다 — 왜 `title`이 아니라 이것인가를 설명하는 그 내용은 여전히 참이다. 다만 그 주석 끝에 한 줄 덧붙인다:

```
 * 카드 자체는 이제 `InfoPopover`가 그린다 — 호버 전용이던 것이 탭과 키보드로도 열리고, top layer로
 * 올라가 조상의 `overflow`에 잘리지 않는다. 이 함수는 "텍스트 한 덩이"라는 좁은 경우를 위한 얇은
 * 껍질로 남는다.
```

- [ ] **Step 6: `Tip` 호출처 열 곳이 깨지지 않았는지 확인한다**

Run: `pnpm vitest run web/tests/ && pnpm typecheck:web`
Expected: PASS. `Tip`의 공개 시그니처가 그대로이므로 호출처는 한 줄도 고치지 않는다. `OutletCard.test.tsx`·`TranslationDetail.test.tsx`가 `Tip`의 문구를 읽는다면 이제 **닫힌 상태에서는 DOM에 없다** — 그 테스트가 깨지면 클릭으로 연 뒤 읽도록 고친다(문구를 지우지 말 것).

- [ ] **Step 7: 커밋**

```bash
git add web/src/components/InfoPopover.tsx web/src/components/ConfirmDialog.tsx web/tests/InfoPopover.test.tsx
git commit -m "feat(web): make the board's hover cards reachable by tap and keyboard"
```

---

### Task 3: 남은 손수 만든 호버 카드 넷을 `InfoPopover`로 접는다

`App.tsx`의 스토리지 패널, `CollectedBreakdownCard`, `OpenLink`가 같은 idiom을 손으로 다시 쓴 것이다. (`MarkerText`는 Task 5에서 다르게 처리한다 — 팝오버가 아니라 인라인이다.)

**Files:**
- Modify: `web/src/App.tsx:260-383` (스토리지 pill 패널)
- Modify: `web/src/components/CollectedBreakdownCard.tsx:29-35`
- Modify: `web/src/components/TranslationDetail.tsx:77-95` (`OpenLink`)
- Test: `web/tests/App.test.tsx` (기존 파일에 케이스 추가)

**Interfaces:**
- Consumes: Task 2의 `InfoPopover`, `Tip`
- Produces: 없음 (호출처 정리)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`web/tests/App.test.tsx`에 새 `describe`로 추가한다. 이 파일의 기존 헬퍼는 `stubFetch(extra?)`이고(`:58`), `/api/status`의 `storageMode`는 `"local"`이다(`:65`). 렌더는 `render(<App onSignOut={() => {}} authEpoch={0} />)`이며, 이 파일은 자식 뷰들을 `vi.mock`으로 갈아끼우므로 헤더만 검증하는 이 케이스에는 영향이 없다.

```tsx
describe("헤더의 호버 카드", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("스토리지 모드 패널이 클릭으로 열린다 — 터치에는 호버가 없다", async () => {
    stubFetch();
    render(<App onSignOut={() => {}} authEpoch={0} />);

    // status가 실려야 pill이 그려진다.
    await screen.findByText("local");
    expect(screen.queryByText("지금 확인")).toBeNull();

    fireEvent.click(screen.getByText("local"));
    expect(screen.getByText("지금 확인")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run web/tests/App.test.tsx`
Expected: FAIL — 클릭 전에 이미 `지금 확인`이 DOM에 있으므로 첫 `expect`에서 실패한다(지금은 CSS로만 숨기고 있다).

- [ ] **Step 3: `App.tsx`의 스토리지 패널을 옮긴다**

`App.tsx:261`의 `<div className="group relative shrink-0">`부터 `:382`의 닫는 `</div>`까지가 대상이다. `InfoPopover`로 감싸고, 두 겹 박스(`:292`의 `pt-2` 패딩 트릭)를 걷어낸다.

구조:

```tsx
{status && (
  <InfoPopover
    className="shrink-0"
    panelClassName="w-72 p-3 text-[12px] leading-relaxed text-muted"
    panel={/* 기존 :293-380 안쪽 내용 그대로 */}
  >
    <span className={/* 기존 :263-269의 pill */}>…</span>
    {chip && <span className={/* 기존 :271-278 */}>…</span>}
  </InfoPopover>
)}
```

지울 것과 이유:

- `:292`의 바깥 박스와 `pt-2` 트릭 — 포인터가 pill에서 카드로 건너가는 죽은 구간을 없애려던 것인데, `InfoPopover`가 `pointerLeave`를 래퍼(트리거+카드를 함께 감싸는 `<span>`)에서 받으므로 필요 없다.
- `pointer-events-auto` — top layer에서는 기본이 이미 그렇다.
- `hidden`/`group-hover:block` — 상태가 렌더를 결정한다.

`:279-291`의 긴 주석은 지운다. 그 주석이 설명하던 문제(두 겹 박스와 `pt-2`)가 사라지므로 남기면 없는 구조를 설명하게 된다. 대신 `InfoPopover`의 doc 주석이 이 자리의 근거를 이미 들고 있다.

- [ ] **Step 4: `CollectedBreakdownCard`를 옮긴다**

이 컴포넌트는 지금 **카드만** 그리고 위치잡기는 부모(`App.tsx:461-494`의 `group/collected relative`)가 한다. `InfoPopover`가 트리거와 카드를 함께 들므로 경계를 바꾼다.

`CollectedBreakdownCard.tsx:32-35`의 바깥 `<div>`를 카드 내용만 남기는 `<>…</>`로 바꾸고, `data-testid="collected-breakdown"`은 유지한다(테스트가 읽는다):

```tsx
export function CollectedBreakdownCard({ breakdown }: { breakdown: CollectedBreakdown }) {
  const reach = reachCopy(breakdown.reach);
  return (
    <div data-testid="collected-breakdown" className="text-left">
      {/* :36-83 기존 내용 그대로 */}
    </div>
  );
}
```

그리고 `App.tsx`의 수집 스테이지(`:461-494`)에서 `group/collected relative cursor-help`와 `title={collected ? "" : undefined}` 트릭을 걷어내고, 수집 스테이지의 두 span을 `InfoPopover`로 감싼다:

```tsx
{collected ? (
  <InfoPopover panelClassName="w-80 p-3 text-[12px] font-normal leading-relaxed text-muted">
    …두 span…
  </InfoPopover>
) : (
  …두 span…
)}
```

`title=""` 트릭이 사라지는 이유: 그것은 조상의 `title`이 카드 위에 겹쳐 뜨는 것을 막으려던 것이었는데, 카드가 top layer로 올라가면 겹칠 대상이 없다.

**주의:** `App.tsx:456-458`의 주석이 "구분자는 스테이지의 형제여야 테스트가 스테이지 하나씩 읽을 수 있다"고 못박고 있다. `InfoPopover`는 스테이지 **안쪽**을 감싸야 하고, `data-testid={`funnel-${key}`}`가 붙은 `<div>`를 대체하면 안 된다.

- [ ] **Step 5: `OpenLink`를 `Tip`으로 접는다**

`TranslationDetail.tsx:77-95`의 비활성 분기를 손수 만든 카드 대신 `Tip`으로 바꾼다:

```tsx
function OpenLink({ href, active, children }: { href: string; active: boolean; children: string }) {
  if (!active) {
    return (
      <Tip text="발행을 다시 눌러야 열 수 있어요">
        <span className="cursor-not-allowed text-faint">{children}</span>
      </Tip>
    );
  }
  return (
    <a className="text-mint underline-offset-2 hover:underline" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
```

`:82-83`의 주석("same as `Tip` and the board's other hover cards" + `whitespace-nowrap`을 따로 쓰는 이유)은 지운다 — 이제 진짜로 `Tip`이므로 설명할 차이가 없다. `w-64` 카드가 한 줄짜리 문구에는 넓지만, 어휘를 하나로 두는 값이 그 폭보다 크다.

- [ ] **Step 6: 테스트와 타입을 확인한다**

Run: `pnpm vitest run web/tests/ && pnpm typecheck:web`
Expected: PASS. `App.test.tsx`의 새 케이스가 통과하고, `collected-breakdown`을 읽는 기존 테스트가 있으면 **클릭으로 연 뒤 읽도록** 고친다.

- [ ] **Step 7: 브라우저에서 확인한다**

Run: `pnpm dev:web`. 스토리지 pill과 수집 스테이지를 (1) 마우스로 호버, (2) 클릭, (3) Tab으로 이동 후 Enter — 세 경로 모두에서 카드가 열리는지 본다. 헤더 안에서 카드가 잘리지 않는지도 확인한다(top layer가 하는 일).

- [ ] **Step 8: 커밋**

```bash
git add web/src/App.tsx web/src/components/CollectedBreakdownCard.tsx \
        web/src/components/TranslationDetail.tsx web/tests/App.test.tsx
git commit -m "feat(web): fold the four hand-rolled hover cards into one component"
```

---

### Task 4: `ListDetailShell` — 셸 두 벌을 한 벌로, 폰에서는 드로우

**Files:**
- Create: `web/src/components/ListDetailShell.tsx`
- Modify: `web/src/App.tsx:524-548` (1차 검수 셸)
- Modify: `web/src/components/RenderingsView.tsx:44-92` (2차 검수 셸)
- Test: `web/tests/ListDetailShell.test.tsx` (신규)

**Interfaces:**
- Consumes: Task 1의 `tablet:`
- Produces:
  - `ListDetailShell({ list, detail, current }): JSX.Element`
    - `list: ReactNode` — 사이드바에 들어갈 목록
    - `detail: ReactNode` — 상세 pane 내용
    - `current?: string` — 폰 바에 표시할 "지금 보고 있는 것" (없으면 `"목록에서 고르세요"`)
  - 목록에서 항목을 고르면 드로우가 닫혀야 하는데, 셸은 선택을 모른다. `current`가 바뀌면 닫는 것으로 처리한다 — 선택이 곧 `current`의 변화이기 때문이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`web/tests/ListDetailShell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ListDetailShell } from "../src/components/ListDetailShell";

afterEach(cleanup);

/**
 * 폭에 따른 배치 자체는 CSS의 일이고 jsdom은 그것을 계산하지 않는다. 여기서 검증하는 것은 드로우의
 * 상태 기계 — 열리는가, 고르면 닫히는가, Esc로 닫히는가 — 뿐이다. 배치는 Task 11의 Playwright가 본다.
 */
describe("ListDetailShell", () => {
  const Harness = () => {
    const [picked, setPicked] = useState<string | null>(null);
    return (
      <ListDetailShell
        current={picked ?? undefined}
        list={
          <ul>
            <li><button onClick={() => setPicked("250817 첫 항목")}>250817 첫 항목</button></li>
            <li><button onClick={() => setPicked("250816 둘째 항목")}>250816 둘째 항목</button></li>
          </ul>
        }
        detail={<p>{picked ? `${picked} 상세` : "고르세요"}</p>}
      />
    );
  };

  it("☰로 드로우를 열고 다시 눌러 닫는다", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "목록 열기" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "목록 닫기" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "목록 닫기" }));
    expect(screen.getByRole("button", { name: "목록 열기" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("항목을 고르면 드로우가 닫힌다 — 목록이 상세를 덮은 채로 남으면 고른 것을 볼 수 없다", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "목록 열기" }));
    fireEvent.click(screen.getByText("250817 첫 항목"));
    expect(screen.getByRole("button", { name: "목록 열기" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("250817 첫 항목 상세")).toBeTruthy();
  });

  it("Esc로 닫힌다", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "목록 열기" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "목록 열기" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("지금 보고 있는 것을 폰 바에 적는다 — 드로우가 닫히면 목록의 하이라이트가 안 보인다", () => {
    render(<Harness />);
    expect(screen.getByTestId("current-item").textContent).toBe("목록에서 고르세요");
    fireEvent.click(screen.getByRole("button", { name: "목록 열기" }));
    fireEvent.click(screen.getByText("250816 둘째 항목"));
    expect(screen.getByTestId("current-item").textContent).toBe("250816 둘째 항목");
  });

  it("목록과 상세는 폭과 무관하게 항상 트리에 있다 — 리마운트되면 스크롤과 검색어를 잃는다", () => {
    render(<Harness />);
    expect(screen.getByText("250817 첫 항목")).toBeTruthy();
    expect(screen.getByText("고르세요")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run web/tests/ListDetailShell.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/ListDetailShell"`

- [ ] **Step 3: `ListDetailShell`을 구현한다**

`web/src/components/ListDetailShell.tsx`:

```tsx
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
```

`max-w-[85vw]`인 이유: 320px 드로우가 360px 폰에서 화면을 거의 다 덮으면 백드롭을 누를 곳이 남지 않아 닫을 길이 사라진다. 태블릿에서는 `tablet:max-w-none`으로 되돌린다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run web/tests/ListDetailShell.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: 1차 검수를 셸로 바꾼다**

`web/src/App.tsx:524-548`을 교체한다. import에 `ListDetailShell`을 추가하고:

```tsx
      {mode === "translations" && (
        <ListDetailShell
          current={selected?.itemId}
          list={<TranslationList items={items} selectedId={selectedId} onSelect={handleSelect} />}
          detail={
            selected ? (
              <TranslationDetail
                item={selected}
                publishRows={publishRows.filter((r) => r.itemId === selected.itemId)}
                availableTargets={status?.availableTargets ?? []}
                onSave={onSave}
                onApprove={onApprove}
                onUnapprove={onUnapprove}
                onUnretire={onUnretire}
                onRetire={onRetire}
                onPublish={onPublishOne}
                onDirtyChange={setDirty}
              />
            ) : (
              <EmptyState title="검수할 항목을 선택하세요" hint="왼쪽 목록에서 번역을 골라 원문과 나란히 확인하고 승인합니다." />
            )
          }
        />
      )}
```

- [ ] **Step 6: 2차 검수를 셸로 바꾼다**

`web/src/components/RenderingsView.tsx:49-90`을 같은 방식으로 교체한다. `<>…</>`와 그 안의 `error` 블록(`:46-48`)은 그대로 두고 `<div className="flex min-h-0 flex-1">`부터가 대상이다.

```tsx
      <ListDetailShell
        current={selected?.itemId}
        list={<RenderingList items={items} selectedId={selectedId} onSelect={handleSelect} />}
        detail={
          selected ? (
            <OutletBoard
              key={selected.itemId}
              itemId={selected.itemId}
              convertedByType={Object.fromEntries(
                items.filter((r) => r.itemId === selected.itemId).map((r) => [r.type, r.convertedText]),
              )}
              postedAt={selected.postedAt}
              kind={selected.kind}
              onGroupChanged={refresh}
              onDirtyChange={setDirty}
              authEpoch={authEpoch}
              conversionEnabled={conversionEnabled}
              sendsEnabled={sendsEnabled}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-10">
              <div className="max-w-sm text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface text-faint">
                  ☰
                </div>
                <p className="text-sm font-medium text-ink">검수하고 보낼 항목을 선택하세요</p>
                <p className="mt-1 text-[13px] leading-relaxed text-faint">
                  목록이 비어 있으면 먼저 <code className="font-mono">pnpm format</code> 을 실행하세요.
                </p>
              </div>
            </div>
          )
        }
      />
```

`OutletBoard`의 `key={selected.itemId}` 주석(`:59-62`)이 설명하는 이유는 그대로 유효하므로 **반드시 유지한다.**

- [ ] **Step 7: 회귀를 확인한다**

Run: `pnpm vitest run web/tests/ && pnpm typecheck:web`
Expected: PASS. `App.test.tsx`·`OutletBoard.test.tsx`가 두 pane의 존재를 단정한다면 그대로 통과해야 한다 — 둘 다 여전히 트리에 있다.

- [ ] **Step 8: 커밋**

```bash
git add web/src/components/ListDetailShell.tsx web/src/App.tsx \
        web/src/components/RenderingsView.tsx web/tests/ListDetailShell.test.tsx
git commit -m "feat(web): one list-detail shell for both review tabs, a drawer on phones"
```

---

### Task 5: 미디어 미리보기 — 좁으면 팝오버가 아니라 인라인

**Files:**
- Modify: `web/src/components/MarkerText.tsx:22-119`
- Modify: `web/src/components/TranslationDetail.tsx:245` (원문 pane에 `@container`)
- Modify: `web/src/components/OutletCard.tsx:557` 부근 (`MarkerText`를 쓰는 읽기 전용 pane에 `@container`)
- Test: `web/tests/MarkerText.test.tsx` (기존 파일에 케이스 추가)

**Interfaces:**
- Consumes: 없음
- Produces: 없음 (`MarkerText`의 공개 시그니처 불변)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`web/tests/MarkerText.test.tsx`에 추가한다:

```tsx
  it("사진 라벨을 탭하면 미리보기가 펼쳐지고, 다시 탭하면 접힌다", () => {
    render(<MarkerText text={"앞줄\n[사진](https://pbs.twimg.com/x.jpg)\n뒷줄"} />);
    expect(document.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByText("[사진]"));
    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://pbs.twimg.com/x.jpg");
    fireEvent.click(screen.getByText("[사진]"));
    expect(document.querySelector("img")).toBeNull();
  });

  it("영상은 열기 전에 마운트하지 않는다 — 마커 열두 개가 mp4를 전부 당겨오면 안 된다", () => {
    render(<MarkerText text={"[영상] https://video.twimg.com/x.mp4"} />);
    expect(document.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByText("[영상]"));
    expect(document.querySelector("video")?.getAttribute("src")).toBe("https://video.twimg.com/x.mp4");
  });

  it("한 번 연 영상은 접어도 마운트를 유지한다 — 두 번째로 볼 때 버퍼를 버리지 않는다", () => {
    render(<MarkerText text={"[영상] https://video.twimg.com/x.mp4"} />);
    fireEvent.click(screen.getByText("[영상]"));
    fireEvent.click(screen.getByText("[영상]"));
    // 접힌 상태에서는 보이지 않지만 DOM에는 남는다.
    expect(document.querySelector("video")).not.toBeNull();
  });

  it("원본 보기 링크는 열림과 무관하게 항상 있다", () => {
    render(<MarkerText text={"[사진](https://pbs.twimg.com/x.jpg)"} />);
    expect(screen.getByText("원본 보기 ↗").getAttribute("href")).toBe("https://pbs.twimg.com/x.jpg");
  });
```

기존 파일의 import(`fireEvent`, `screen`)가 없으면 추가한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run web/tests/MarkerText.test.tsx`
Expected: FAIL — 지금은 `img`가 처음부터 마운트돼 있고(CSS로만 숨김) 클릭 핸들러가 없다.

- [ ] **Step 3: `MediaMarker`를 다시 쓴다**

`web/src/components/MarkerText.tsx:22-60`을 교체한다:

```tsx
/**
 * 미디어 마커 하나 — 라벨, 그 자리에서 펼쳐지는 미리보기, 그리고 원본 링크.
 *
 * 다른 호버 카드들과 달리 이것만 `InfoPopover`로 가지 않는다. 폰에서 320px 팝오버는 원문을 거의 다
 * 덮는데, 이 미리보기의 용도가 **원문 문장과 사진을 대조하는 것**이다. 덮으면 목적이 사라진다.
 * 그래서 그 자리에서 아래로 펼치는 아코디언이고, 폭 판단은 뷰포트가 아니라 이 pane 자신의 폭이므로
 * (같은 컴포넌트가 좁은 상세 pane과 넓은 데스크톱 양쪽에 놓인다) 호출처가 `@container`를 건다.
 *
 * 지연 마운트는 유지된다. `autoPlay`는 `preload="none"`을 무시하고, 팝오버가 CSS로만 숨겨져 있어도
 * 미디어 요소는 네트워크를 탄다 — 2차 카드는 마커를 열두 개까지 띄우므로, 즉시 마운트하면 아무도
 * 보지 않은 mp4 열두 개를 당겨온다. 예전에는 `onMouseEnter`가 arm 신호였고 지금은 첫 열기가 그
 * 일을 한다. 한 번 arm되면 접어도 마운트를 유지한다(두 번째로 볼 때 버퍼를 버리지 않는다).
 *
 * `pointer-events-none`과 "`원본 보기`를 호버 타깃 밖에 둔다"는 예전 규칙은 여기서 사라졌다. 둘 다
 * "포인터가 이동하다 미리보기를 떨어뜨리는 것"을 막으려던 것인데, 클릭으로 여닫는 지금은 포인터가
 * 어디로 가든 열린 채로 남는다.
 */
function MediaMarker({
  label,
  url,
  broken,
  preview,
}: {
  label: string;
  url: string;
  broken: string;
  preview: (onError: () => void) => ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);

  return (
    <span className="inline">
      <button
        type="button"
        onClick={() => {
          setArmed(true);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="cursor-pointer text-mint underline-offset-2 hover:underline"
      >
        {label}
      </button>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="ml-1.5 text-[12px] font-medium text-muted underline-offset-2 hover:text-mint hover:underline"
      >
        원본 보기 ↗
      </a>
      {armed && (
        <span className={`${open ? "block" : "hidden"} mt-1.5 rounded-lg border border-line bg-surface p-1.5`}>
          {failed ? (
            <span className="block px-1 py-0.5 text-[12px] leading-relaxed text-muted">{broken}</span>
          ) : (
            preview(() => setFailed(true))
          )}
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 4: `PhotoMarker`/`VideoMarker`를 맞춘다**

`onMouseEnter` prop이 사라졌으므로 `VideoMarker`(`:96-119`)에서 `armed` 상태와 `onMouseEnter`를 걷어낸다 — 이제 `MediaMarker`가 arm을 관리한다:

```tsx
function VideoMarker({ url }: { url: string }) {
  return (
    <MediaMarker
      label="[영상]"
      url={url}
      broken="영상을 불러오지 못했습니다"
      preview={(onError) => (
        <video
          src={url}
          className="block max-h-64 w-full max-w-80 object-contain"
          autoPlay
          muted
          loop
          playsInline
          onError={onError}
        />
      )}
    />
  );
}
```

`PhotoMarker`(`:63-79`)의 `<img>` className도 `block max-h-64 w-full max-w-80 object-contain`으로 바꾼다. `w-80 max-w-[70vw]`였던 것을 `w-full max-w-80`으로 뒤집는 이유: 이제 팝오버가 아니라 흐름 안에 있으므로 좁은 pane에서는 pane을 채우고, 넓은 곳에서는 320px에서 멈춘다. `70vw`는 뷰포트를 보던 값이라 컨테이너 기준으로 옮기면 뜻이 맞지 않는다.

`VideoMarker`의 doc 주석(`:81-95`)에서 `onMouseEnter`/`preload="none"`을 설명하는 문단은 `MediaMarker` 쪽으로 옮겼으므로 지우고, `muted`/`playsInline`/`loop`의 이유를 적은 문단은 남긴다.

- [ ] **Step 5: 호출처에 `@container`를 건다**

- `TranslationDetail.tsx:245`: `className="rounded-xl border border-line bg-surface p-4 …"` 앞에 `@container `를 더한다.
- `OutletCard.tsx:557`의 `<div className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-muted">`에도 `@container `를 더한다.

지금은 컨테이너 변형(`@sm:` 등)을 쓰지 않으므로 이 자체로는 화면이 바뀌지 않는다. 컨테이너를 **선언**해 두는 것이 목적이고, 미리보기 폭이 실제로 나빠 보이면 여기에 `@sm:` 변형을 붙이면 된다 — 그 판정은 Task 11이다.

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run web/tests/MarkerText.test.tsx && pnpm typecheck:web`
Expected: PASS. 기존 `MarkerText.test.tsx`의 케이스 중 호버를 전제한 것이 있으면 클릭으로 고친다.

- [ ] **Step 7: 커밋**

```bash
git add web/src/components/MarkerText.tsx web/src/components/TranslationDetail.tsx \
        web/src/components/OutletCard.tsx web/tests/MarkerText.test.tsx
git commit -m "feat(web): open media previews in place instead of over the text they explain"
```

---

### Task 6: `승인됨 ✓` — 터치에서는 확인 다이얼로그

**Files:**
- Modify: `web/src/buttonStyles.ts:25-33`
- Modify: `web/src/components/TranslationDetail.tsx:300-345` (인라인 복제본을 `buttonStyles`로 접고 확인 경로 추가)
- Modify: `web/src/components/OutletCard.tsx:363-379`, `:1123-1135`
- Test: `web/tests/TranslationDetail.test.tsx` (기존 파일에 케이스 추가)

**Interfaces:**
- Consumes: `ConfirmRequest`/`ConfirmDialog` (`ConfirmDialog.tsx:3-36`), Task 1의 `pointer-coarse` 어휘
- Produces:
  - `ApprovedButton({ onUnapprove, disabled? }): JSX.Element` — `buttonStyles.ts`가 아니라 `web/src/components/ApprovedButton.tsx`에 둔다(`buttonStyles.ts`는 문자열만 들고 JSX를 들지 않는다)
  - `onUnapprove: () => void` — 확인을 거친 뒤에만 불린다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`web/tests/TranslationDetail.test.tsx`에 추가한다. 이 파일의 헬퍼는 `mount(item, opts)`(`:20-43`)와 `translation(overrides)`(`:10-18`)다.

**먼저 `mount`의 옵션에 `onUnapprove`를 뚫는다** — 지금은 `onUnapprove={async () => {}}`로 하드코딩돼 있어 스파이를 넣을 수 없다:

```tsx
function mount(
  item: Translation,
  o: {
    onUnapprove?: (id: string) => Promise<void>;
    onUnretire?: (id: string) => Promise<void>;
    onRetire?: (id: string) => Promise<void>;
    publishRows?: PublishStateRow[];
    availableTargets?: ("local" | "google" | "lark")[];
  } = {},
) {
  return render(
    <TranslationDetail
      …
      onUnapprove={o.onUnapprove ?? (async () => {})}
      …
    />,
  );
}
```

그 위에 케이스 둘:

```tsx
describe("승인 취소", () => {
  it("확인을 거쳐야 취소된다 — 터치에는 호버 스왑이 없고, 탭에 :hover가 걸리는 브라우저에서는 손가락 아래 라벨이 바뀐다", async () => {
    const onUnapprove = vi.fn().mockResolvedValue(undefined);
    mount(translation({ status: "approved" }), { onUnapprove });

    fireEvent.click(screen.getByRole("button", { name: /승인됨/ }));
    expect(onUnapprove).not.toHaveBeenCalled();

    // 다이얼로그가 뜬 뒤의 확인 버튼. 트리거의 호버 라벨은 `aria-hidden`이라 이름이 겹치지 않는다.
    fireEvent.click(screen.getByRole("button", { name: "승인 취소" }));
    await waitFor(() => expect(onUnapprove).toHaveBeenCalledTimes(1));
  });

  it("확인을 취소하면 승인이 유지된다", () => {
    const onUnapprove = vi.fn();
    mount(translation({ status: "approved" }), { onUnapprove });

    fireEvent.click(screen.getByRole("button", { name: /승인됨/ }));
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onUnapprove).not.toHaveBeenCalled();
  });
});
```

`waitFor`를 이 파일의 import에 추가한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run web/tests/TranslationDetail.test.tsx`
Expected: FAIL — 지금은 클릭이 곧바로 `onUnapprove`를 부른다.

- [ ] **Step 3: `ApprovedButton`을 만든다**

`web/src/components/ApprovedButton.tsx`:

```tsx
import { useState } from "react";
import { btnApproved, btnApprovedHover, btnApprovedRest } from "../buttonStyles";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";

/**
 * `승인됨 ✓`. 마우스에서는 호버로 `승인 취소`가 되고, 터치에서는 확인 다이얼로그를 거친다.
 *
 * 호버 스왑이 터치에서 성립하지 않는 것은 단순히 "호버가 없어서"가 아니다. 일부 터치 브라우저는
 * 탭에 `:hover`를 적용하므로, 손가락 아래에서 라벨이 `승인됨 ✓`에서 `승인 취소`로 바뀐다 —
 * 취소를 의도하지 않은 사람이 취소를 누르는 경로다. 다이얼로그는 그 경로를 끊으면서 오탭 방지를
 * 겸한다.
 *
 * 다이얼로그가 마우스에서도 뜨는 이유: 경로가 둘이면 둘 다 테스트해야 하고, 승인 취소는 데스크톱에서도
 * 되돌리기가 필요한 동작이다. 호버 스왑은 "무엇을 누르는 버튼인지" 알려주는 라벨로 남고, 확인은
 * 양쪽 공통이다.
 */
export function ApprovedButton({ onUnapprove, disabled }: { onUnapprove: () => void; disabled?: boolean }) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  return (
    <>
      <button
        type="button"
        className={btnApproved}
        disabled={disabled}
        onClick={() =>
          setConfirm({
            title: "승인을 취소할까요?",
            lines: ["이 항목이 다시 검수 대기로 돌아갑니다.", "저장된 글은 그대로 남습니다."],
            confirmLabel: "승인 취소",
            tone: "danger",
            onConfirm: () => onUnapprove(),
          })
        }
      >
        <span className={btnApprovedRest}>승인됨 ✓</span>
        {/* 호버로 드러나는 시각적 라벨일 뿐, 이 버튼의 이름이 아니다. `aria-hidden`이 없으면 이
            버튼의 접근 이름이 "승인됨 ✓ 승인 취소"가 되고, 다이얼로그가 열린 뒤에는
            `getByRole("button", { name: "승인 취소" })`가 트리거와 확인 버튼 둘을 만나 실패한다.
            스크린리더 입장에서도 한 버튼이 두 동작을 말하는 것은 틀렸다. */}
        <span className={btnApprovedHover} aria-hidden="true">
          승인 취소
        </span>
      </button>
      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
    </>
  );
}
```

- [ ] **Step 4: 세 호출처를 바꾼다**

- `TranslationDetail.tsx:321-334`의 인라인 복제본을 `<ApprovedButton onUnapprove={() => run(() => props.onUnapprove(props.item.itemId))} disabled={busy} />`로 교체한다. 이 자리가 `buttonStyles.ts`의 문자열을 쓰지 않고 손으로 다시 쓴 곳이라, 이번에 접힌다.
- `OutletCard.tsx:363-379`와 `:1123-1135`도 같은 방식으로 교체한다. 각 자리의 `onClick`이 부르던 함수를 `onUnapprove`로 넘긴다.

- [ ] **Step 5: `buttonStyles.ts`의 주석을 갱신한다**

`buttonStyles.ts:25-29`의 `btnApproved` 주석에 한 줄 더한다:

```
 * 이 세 문자열을 직접 쓰지 말고 `ApprovedButton`을 쓸 것 — 터치에서 호버 스왑이 성립하지 않는
 * 문제(손가락 아래에서 라벨이 바뀐다)를 그 컴포넌트가 확인 다이얼로그로 막는다.
```

- [ ] **Step 6: 테스트와 타입을 확인한다**

Run: `pnpm vitest run web/tests/ && pnpm typecheck:web`
Expected: PASS. `OutletCard.test.tsx`가 승인 취소를 직접 클릭으로 검증한다면 다이얼로그를 거치도록 고친다.

- [ ] **Step 7: 커밋**

```bash
git add web/src/components/ApprovedButton.tsx web/src/buttonStyles.ts \
        web/src/components/TranslationDetail.tsx web/src/components/OutletCard.tsx \
        web/tests/TranslationDetail.test.tsx
git commit -m "feat(web): confirm an approval reversal instead of hiding it behind hover"
```

---

### Task 7: 터치 타깃 44px

**Files:**
- Modify: `web/src/buttonStyles.ts:9`
- Modify: `web/src/App.tsx:390` (nav 탭)
- Modify: `web/src/components/TranslationDetail.tsx:233` (`게시됨으로`)
- Modify: `web/src/components/ConfirmDialog.tsx:134`, `:141` (취소/확인 버튼)
- Test: `web/tests/touchTargets.test.ts` (신규)

**Interfaces:**
- Consumes: Task 1의 어휘
- Produces: 없음

- [ ] **Step 1: 실패하는 가드 테스트를 쓴다**

`web/tests/touchTargets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 손가락에 맞는 최소 크기(44px)를 `pointer-coarse`에서만 준다. 뷰포트가 아니라 입력 장치를 보므로
 * 창을 좁힌 데스크톱에서 버튼이 뚱뚱해지지 않고, 터치 노트북에서는 커진다.
 *
 * 문자열로 고정하는 이유: 이 클래스가 빠지면 화면은 멀쩡해 보이고 손가락만 빗나간다 — 눈으로
 * 리뷰해서 잡히지 않는 종류의 회귀다.
 */
it("보드 버튼의 공통 BASE가 pointer-coarse 최소 높이를 들고 있다", () => {
  const source = readFileSync(join(__dirname, "../src/buttonStyles.ts"), "utf8");
  const base = source.match(/const BASE = "([^"]+)"/)?.[1];
  expect(base).toBeDefined();
  expect(base).toContain("pointer-coarse:min-h-11");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run web/tests/touchTargets.test.ts`
Expected: FAIL — `BASE`에 그 클래스가 없다.

- [ ] **Step 3: `BASE`에 한 줄 더한다**

`web/src/buttonStyles.ts:9`:

```ts
const BASE =
  "rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors pointer-coarse:min-h-11";
```

바로 위 주석에 이유를 더한다:

```
// `pointer-coarse:min-h-11`(44px)은 손가락용 최소 크기다. 뷰포트가 아니라 입력 장치를 보는 변형이라
// 창을 좁힌 데스크톱에서는 버튼이 그대로고, 터치 노트북에서는 커진다 — 밀도 높은 이 보드에서
// 브레이크포인트로 같은 일을 하면 마우스 쓰는 사람까지 뚱뚱한 버튼을 받는다.
```

`btn`·`btnPrimary`·`btnDanger`·`btnApprove`·`btnApproved`가 전부 `BASE`를 공유하므로 이 한 줄이 보드의 모든 버튼을 고친다.

- [ ] **Step 4: `BASE`를 쓰지 않는 버튼 네 곳을 훑는다**

- `App.tsx:390` (nav 탭): `className={...}`의 문자열에 `pointer-coarse:min-h-11 ` 을 더한다.
- `TranslationDetail.tsx:233` (`게시됨으로`): 같다.
- `ConfirmDialog.tsx:134`(취소), `:141`(확인): 같다.

`ListDetailShell`의 ☰는 Task 4에서 이미 `min-h-11 min-w-11`로 만들었다 — 그것은 폰 전용 바에만 있으므로 `pointer-coarse` 없이 무조건 크다.

- [ ] **Step 5: 테스트와 회귀를 확인한다**

Run: `pnpm vitest run web/tests/ && pnpm typecheck:web`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add web/src/buttonStyles.ts web/src/App.tsx web/src/components/TranslationDetail.tsx \
        web/src/components/ConfirmDialog.tsx web/tests/touchTargets.test.ts
git commit -m "feat(web): size the board's buttons for fingers on touch devices"
```

---

### Task 8: 헤더 — 폰에서 탭 라벨과 로고를 줄인다

**Files:**
- Modify: `web/src/App.tsx:25-29` (`TABS`에 `short`), `:255-257` (로고), `:386-396` (탭 렌더)
- Test: `web/tests/App.test.tsx` (기존 파일에 케이스 추가)

**Interfaces:**
- Consumes: Task 1의 `tablet:`
- Produces: `TABS[number].short: string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`web/tests/App.test.tsx`에 추가한다. 헬퍼는 Task 3과 같다.

```tsx
  it("탭은 축약 라벨과 전체 라벨을 둘 다 들고 있다 — 어느 쪽이 보이는지는 CSS가 정한다", async () => {
    stubFetch();
    render(<App onSignOut={() => {}} authEpoch={0} />);

    await screen.findByText("1차 검수 · 번역");
    expect(screen.getByText("1차")).toBeTruthy();
    expect(screen.getByText("수집")).toBeTruthy();
  });
```

`getByText`는 정확히 일치하는 텍스트 노드를 찾으므로 `"1차"`와 `"1차 검수 · 번역"`이 서로를 잡지 않는다 — 두 span이 별개의 노드이기 때문이다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run web/tests/App.test.tsx`
Expected: FAIL — 축약 라벨이 DOM에 없다.

- [ ] **Step 3: `TABS`에 `short`를 더한다**

`web/src/App.tsx:25-29`:

```tsx
const TABS = [
  { id: "translations", hash: "", label: "1차 검수 · 번역", short: "1차" },
  { id: "renderings", hash: "#renderings", label: "2차 검수 · 채널", short: "2차" },
  { id: "intake", hash: "#intake", label: "링크 수집", short: "수집" },
] as const;
```

`:16-24`의 주석에 한 줄 더한다 — 그 주석이 "탭의 네 가지 사실은 한 곳에"라고 선언하고 있으므로 다섯 번째가 늘었다는 사실을 적는다:

```
 * 다섯 번째 사실은 `short` — 폰에서 쓰는 축약 라벨이다. 세 탭의 전체 라벨은 390px 헤더에서 다른
 * 컨트롤들과 함께 세 줄로 접히는데, 이 대시보드에서 헤더 세 줄은 상세 pane을 그만큼 밀어낸다.
```

- [ ] **Step 4: 탭 렌더를 바꾼다**

`App.tsx:386-396`의 `{label}`을 두 span으로 바꾼다:

```tsx
                <span className="tablet:hidden">{short}</span>
                <span className="hidden tablet:inline">{label}</span>
```

`map`의 구조 분해도 `{ id, label, short }`로 바꾼다.

- [ ] **Step 5: 로고를 줄인다**

`App.tsx:255-257`:

```tsx
            <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight">
              Mantle KR <span className="text-faint font-normal hidden tablet:inline">Review</span>
            </span>
```

- [ ] **Step 6: 테스트와 회귀를 확인한다**

Run: `pnpm vitest run web/tests/ && pnpm typecheck:web`
Expected: PASS. 기존 테스트가 `getByText("1차 검수 · 번역")`으로 탭을 클릭한다면 그대로 동작한다 — 전체 라벨은 여전히 DOM에 있다.

- [ ] **Step 7: 커밋**

```bash
git add web/src/App.tsx web/tests/App.test.tsx
git commit -m "feat(web): shorten the header's tab labels where the screen is narrow"
```

---

### Task 9: `OutletCard`의 액션 행을 좁을 때 쌓는다

**Files:**
- Modify: `web/src/components/OutletCard.tsx:837-845` (카드 루트에 `@container`), `:1014-1160` (액션 행)
- Test: `web/tests/OutletCard.test.tsx` (기존 파일 — 회귀만 확인)

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: 카드 루트를 컨테이너로 선언한다**

`OutletCard.tsx:837` 부근의 행 루트 `className`에 `@container `를 더한다. 뷰포트가 아니라 카드 자신의 폭을 보게 하는 것이 목적이다 — 이 카드는 폰의 전체폭과 데스크톱의 상세 pane 양쪽에 놓이고, 셸이 바뀌어도 카드는 고치지 않아야 한다.

- [ ] **Step 2: 액션 행이 좁을 때 쌓이게 한다**

`:1014` 부근과 `:1146` 부근의 버튼 묶음 `className`에 컨테이너 변형을 더한다:

```
flex flex-wrap items-center gap-2 @max-sm:flex-col @max-sm:items-stretch
```

`@max-sm`은 컨테이너 기준 24rem(384px) 미만이다. `pointer-coarse:min-h-11`로 커진 버튼이 세 개 이상 한 줄에 들어가면 좁은 카드에서 줄바꿈이 지저분해진다.

- [ ] **Step 3: 회귀를 확인한다**

Run: `pnpm vitest run web/tests/OutletCard.test.tsx && pnpm typecheck:web`
Expected: PASS — 클래스만 바뀌므로 동작 테스트는 영향이 없다.

- [ ] **Step 4: 커밋**

```bash
git add web/src/components/OutletCard.tsx
git commit -m "feat(web): let an outlet card's actions stack when the card itself is narrow"
```

---

### Task 10: `title` 서른 개 등급 분류

**Files:**
- Modify: 아래 Step 1의 목록이 정하는 파일들
- Test: 해당 없음 (기존 테스트 회귀만)

**Interfaces:**
- Consumes: Task 2의 `Tip`
- Produces: 없음

- [ ] **Step 1: 목록을 만든다**

Run:

```bash
cd web/src && grep -rn "title=" --include="*.tsx" . > /tmp/titles.txt && wc -l /tmp/titles.txt
```

각 줄을 셋 중 하나로 분류해 목록에 적는다:

- **A. 그대로 둔다** — 퍼널 안(`App.tsx`의 `:437`, `:470`, `:481`, `:502`)처럼 폰에서 그 요소 자체가 숨는 것. 터치에서 못 보는 것이 맞다.
- **B. `Tip`으로 승격** — 정보가 그 툴팁에만 있는 것. 특히 **비활성 컨트롤에 붙은 `title`**은 전부 여기다. `ConfirmDialog.tsx:157-176`의 `Tip` 주석이 그 이유를 이미 기록하고 있다 — 조건이 `disabled`와 겹치는 `title`은 렌더된 적이 없고, 그렇게 아홉 개가 쌓였다.
- **C. 인라인 한 줄로** — `POSTED_LOCK`처럼 "왜 못 누르는지"를 설명하는 긴 문장. 툴팁보다 본문이 맞다.

- [ ] **Step 2: B 항목을 `Tip`으로 바꾼다**

각 자리에서 `title={x}`를 지우고 컨트롤을 `<Tip text={x}>…</Tip>`로 감싼다. 이미 `Tip`이 있는 자리는 건드리지 않는다.

- [ ] **Step 3: C 항목을 인라인으로 옮긴다**

`POSTED_LOCK`(`TranslationDetail.tsx:270`)은 textarea의 `title`에서 빼고, 그 아래 `MediaEditNoticeSlot` 옆에 한 줄로 적는다. 잠긴 이유는 잠긴 것을 보는 사람이 바로 읽어야 한다.

- [ ] **Step 4: 회귀를 확인한다**

Run: `pnpm vitest run web/tests/ && pnpm typecheck:web`
Expected: PASS. `title` 문구를 읽는 테스트가 있으면 `Tip`을 열어 읽도록 고친다.

- [ ] **Step 5: 커밋**

```bash
git add web/src
git commit -m "feat(web): grade the board's thirty tooltips by whether touch can reach them"
```

---

### Task 11: 세 폭에서 실제로 확인하고, 남은 수치를 판정한다

**Files:**
- Modify: 판정 결과에 따라 `web/src/components/ListDetailShell.tsx` 또는 없음
- Test: 해당 없음

**Interfaces:**
- Consumes: Task 1-10 전부
- Produces: 없음

- [ ] **Step 1: 개발 서버를 띄운다**

Run: `pnpm dev:web`

- [ ] **Step 2: 세 폭을 본다**

Playwright(MCP)로 `390×844`(폰), `834×1112`(태블릿 세로), `1280×800`(데스크톱)에서 세 탭을 전부 연다. 각 폭에서 확인할 것:

- 가로 스크롤이 생기지 않는다 (`document.documentElement.scrollWidth <= clientWidth`)
- 390px: ☰로 드로우가 열리고, 항목을 고르면 닫히고, 상세가 전체폭이다
- 834px: 2단이고, 헤더가 두 줄까지만 접힌다
- 1280px: 오늘과 시각적으로 같다 (이 작업의 비회귀 기준)
- 세 폭 모두: 호버 카드가 잘리지 않는다

- [ ] **Step 3: 768px에서 상세 pane 폭을 판정한다**

`768×1024`로 띄우고 1차 검수에서 번역 하나를 연다. 상세 pane이 448px이 되는데, 한국어 본문이 한 줄 45자 정도로 빡빡한지 본다.

- **읽을 만하면 아무것도 하지 않는다.** 이것이 기본값이다 — 안 써도 되는 분기를 넣지 않는 것이 규율 2번이다.
- **빡빡하면** 사이드바를 한 단 좁힌다. 가장 싼 답은 `ListDetailShell.tsx`의 `aside`에서 `w-80`을 `w-72`로 낮추는 것이고(모든 폭에 적용, 새 분기 없음), 데스크톱에서는 `w-80`을 유지해야 한다는 판정이 서면 그때만 `@theme`에 `--breakpoint-desktop: 64rem`을 더하고 `w-72 desktop:w-80`을 쓴다.

두 번째 경계를 실제로 추가하게 되면 Task 1의 `breakpointVocabulary.test.ts`는 고치지 않아도 된다 — 그 테스트가 막는 것은 되살아난 **기본 스케일**(`sm:`/`md:`/`lg:`)이고, `desktop:`은 우리가 정의한 이름이다.

- [ ] **Step 4: 스크린샷을 남긴다**

세 폭 × 세 탭의 스크린샷을 찍어 PR 본문에 붙인다. 이 작업은 "보이는 것"이 결과물이라, diff만으로는 리뷰할 수 없다.

- [ ] **Step 5: 최종 회귀**

Run: `pnpm test && pnpm typecheck:web && pnpm build:web`
Expected: 전부 통과. `build:web`은 Tailwind가 `tablet:`·`@container`·`pointer-coarse:` 유틸리티를 실제로 생성하는지 확인하는 유일한 자리다.

- [ ] **Step 6: 커밋 (판정 결과가 있을 때만)**

```bash
git add web/src/components/ListDetailShell.tsx
git commit -m "fix(web): narrow the list where a 768px tablet leaves the detail pane cramped"
```

---

## 실행 순서

Task 1은 나머지 전부의 전제다(`tablet:` 어휘). Task 2는 Task 3의 전제다(`InfoPopover`). 그 외에는 다음 묶음끼리 독립이라 순서를 바꿔도 된다:

- {Task 4} 셸
- {Task 5} 미디어
- {Task 6, 7} 버튼
- {Task 8} 헤더
- {Task 9} 카드 내부
- {Task 10} 툴팁

Task 11은 마지막이다.
