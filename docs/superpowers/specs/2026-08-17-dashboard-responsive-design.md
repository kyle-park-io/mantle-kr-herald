# 태블릿·모바일 대응 — 능력을 화면 폭에 묶지 않는다

대시보드는 지금 PC 전용입니다. 정확히 말하면 **셸만** PC 전용입니다.

내용 영역은 이미 폰 모양입니다. `TranslationDetail`은 `mx-auto max-w-3xl` 한 컬럼에 원문과 한글
textarea를 세로로 쌓고(`web/src/components/TranslationDetail.tsx:243-275`), textarea는
`w-full min-h-64 resize-y`입니다. `OutletBoard`도 `max-w-3xl`(`:200`), `IntakeView`는
`max-w-2xl`(`:65`)입니다. 폰에서 못 쓰는 이유가 "글이 화면에 안 들어가서"인 곳은 없습니다.

막는 것은 그 내용을 감싼 2단 셸, 터치에서 도달할 수 없는 정보, 그리고 손가락에 작은 버튼입니다.
이 문서는 그 셋을 고칩니다.

## 범위

- **폰에서도 전부 됩니다.** 읽기·편집·저장·승인·발송·발행 전부입니다.
- 화면 폭에 따라 능력을 빼지 않습니다. 창을 좁혔더니 저장 버튼이 사라지는 앱은 만들지 않습니다.
  폰에서 편집을 빼려면 "폭에 따라 읽기 전용"이라는 분기를 **새로 넣어야** 하므로, 전부 되게 하는
  쪽이 코드도 적습니다.
- 세 탭(1차 검수·2차 검수·링크 수집) 전부입니다.

## 컨벤션 — 값은 중앙집중, 분기는 분산

이 작업이 따르는 규칙을 먼저 적습니다. 뒤의 모든 결정이 여기서 나옵니다.

미디어쿼리를 `styles.css` 아래쪽에 `@media (max-width: …)` 블록으로 몰아넣지 않고,
`mobile.css`/`tablet.css`로 파일을 쪼개지도 않습니다. 둘 다 한 요소의 폰 규칙과 데스크톱 규칙을
서로 안 보이는 거리에 떨어뜨려 놓아서, 하나를 고칠 때 다른 하나를 못 찾게 만듭니다.

분기는 **그 스타일이 선언된 자리에** 나란히 씁니다 — `className="flex-col tablet:flex-row"`.
요소를 지우면 그 분기도 같이 사라지므로 고아 규칙이 생기지 않습니다. 그래서 이 작업이 `styles.css`에
넣는 것은 축의 정의와 전역 base 규칙뿐이고, 반응형 코드 본체는 각 컴포넌트의 className에 있습니다.

규율 셋:

1. **브레이크포인트에는 이름과 뜻을 준다.** `md`는 뜻이 없고 `tablet`은 있다.
2. **화면이 셋이라고 분기도 셋이 아니다.** 레이아웃이 실제로 달라지는 경계만 만들고, 그 사이는
   `flex`가 흡수한다.
3. **셸만 뷰포트 쿼리를 쓰고, 컴포넌트 내부는 컨테이너 쿼리를 쓴다.** 그래야 `OutletCard`가 화면
   폭을 모르는 상태로 있을 수 있고, 셸을 바꿔도 카드를 안 고친다.

## 브레이크포인트는 하나고, 기본값은 버린다

현재 브레이크포인트 변형은 코드 전체에 **네 곳**밖에 없습니다 — `sm:p-8`이
`TranslationDetail.tsx:155`, `OutletBoard.tsx:169`, `OutletBoard.tsx:200`, 그리고 `md:flex`가
`App.tsx:404`. 기본 스케일을 버리고 다시 세우는 비용이 네 줄입니다.

```css
@theme {
  --breakpoint-*: initial;
  /* 이 앱의 유일한 뷰포트 경계. 셸이 1단(드로우) → 2단(고정 사이드바)이 되는 곳이고,
     헤더의 퍼널·시트 링크·sync 칩이 돌아오는 곳도 같은 지점입니다. */
  --breakpoint-tablet: 48rem;   /* 768px */
}
```

경계가 **하나**입니다. 초안에서는 `desktop: 64rem`도 두었는데, 설계를 끝까지 적어 보니 그것을 쓰는
곳이 없었습니다 — 퍼널은 `tablet:`에서 돌아오고(아래 헤더 절), 그 위로는 `flex`가 흡수합니다. 쓰지
않는 분기를 정의하는 것은 규율 2번을 어기는 일이라 지웠습니다. 데스크톱 전용 분기가 실제로 필요해지는
순간에 `--breakpoint-desktop`을 한 줄로 더하면 됩니다.

단위를 `rem`으로 통일한 것은 취향이 아닙니다. Tailwind 기본 브레이크포인트가 `rem`이고, px를 섞으면
생성된 유틸리티의 정렬 순서가 어긋나 분기끼리 서로를 덮어씁니다(Tailwind 문서의 명시된 주의사항).

`max-w-3xl`·`max-w-sm`·`max-w-lg`는 `--container-*` 스케일이라 이 초기화에 걸리지 않습니다.
건드릴 필요가 없습니다.

`md:` → `tablet:`은 **순수 개명**입니다. 둘 다 48rem이라 현재 동작이 그대로 보존됩니다.

## 셸이 두 벌 있다 — 한 벌로 합친다

`App.tsx:525-547`과 `RenderingsView.tsx:49-90`이 구조가 같습니다.

```
flex min-h-0 flex-1
  aside w-80 shrink-0 overflow-y-auto border-r border-line bg-surface [scrollbar-gutter:stable]
  section min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]
```

드로우를 이 두 곳에 각각 넣으면 드로우 로직이 두 벌이 됩니다. `buttonStyles.ts` 헤더 주석이 정확히
그 문제를 경고합니다 — *"a palette change has to be made twice, and nothing catches the second file
going stale."* 그래서 `web/src/components/ListDetailShell.tsx`를 새로 만들고 두 탭이 그것을 씁니다.
드로우는 한 번만 구현되고, 2차 검수가 1차와 다르게 동작할 수 없습니다.

### 드로우는 `popover`가 아니라 CSS 변환이다

`popover`는 HTML **속성**이고 열리기 전에는 `display: none`입니다. 그런데 이 `aside`는 태블릿
이상에서 팝오버가 아니라 정상적인 레이아웃 컬럼이어야 합니다. CSS로는 속성을 뗄 수 없으므로
`popover`를 쓰려면 JS로 폭을 보며 속성을 붙였다 뗐다 하거나 `aside`를 두 벌 렌더해야 합니다. 둘 다 더
나쁩니다.

대신 `aside`를 **모든 폭에서 트리에 하나만** 두고 CSS로 역할을 바꿉니다.

```tsx
// 폰: 화면 밖에서 대기하는 시트 / 태블릿+: 그냥 컬럼
<aside className="fixed inset-y-0 left-0 z-40 w-80 -translate-x-full transition-transform
                  tablet:static tablet:z-auto tablet:translate-x-0 …" />
```

열림은 `translate-x-0`을 더하는 것뿐입니다. 창 크기를 바꿔도 `aside`가 리마운트되지 않으므로
**목록 스크롤 위치와 `SearchBox`의 검색어가 살아남습니다.** 백드롭은 형제 `div` 하나, Esc는 짧은
effect 하나입니다.

### ☰는 헤더가 아니라 상세 pane 위에 둔다

헤더에 두면 드로우 상태를 `App`까지 올려 `RenderingsView`에도 내려보내야 합니다. 셸이 자기 트리거를
직접 들면 그 배선이 아예 없습니다.

게다가 그 바에는 폰에서 "지금 어느 항목을 보고 있는지"를 적을 자리가 필요합니다 — 2단에서는 목록의
하이라이트가 해주던 일인데, 드로우가 닫히면 사라집니다. **헤더는 이 변경에서 건드리지 않습니다.**

항목을 탭하면 드로우를 닫습니다. 목록이 상세를 덮은 채로 남으면 고른 것을 볼 수 없습니다.

### 남는 수치 하나

정확히 768px 기기에서 2단이 되면 상세 pane이 448px입니다. 15px 본문으로 한 줄 45자 정도 — 되기는
하지만 빡빡합니다. `tablet:w-64`를 **미리 넣지 않습니다.** 셸을 만든 뒤 Playwright로 768·834·1024를
실제로 띄워 보고, 눈으로 나쁠 때만 한 줄 더합니다.

## 터치에서 도달할 수 없는 것들

세 종류가 있고, 셋 다 **데스크톱에서 키보드로도 도달할 수 없습니다.** 호버가 유일한 경로이기
때문입니다. 이 절의 수정은 모바일 대응이면서 동시에 PC에 이미 있는 결함을 갚습니다.

### 호버 카드 다섯 곳 → `popover` 컴포넌트 하나

`App.tsx:292`(스토리지 모드), `CollectedBreakdownCard.tsx:34`(수집 내역),
`MarkerText.tsx:39`(미디어 미리보기), `ConfirmDialog.tsx:202`(`Tip`), `TranslationDetail.tsx:84`
(`OpenLink`).

그중 `Tip` 하나가 이미 **호출처 열 곳**을 먹고 있습니다(`OutletCard` 7, `TranslationDetail` 2,
`OutletBoard`가 쓰는 경로 포함). API가 `text: string | undefined`로 좁아서, `Tip`의 내부만 바꾸면 그
열 곳은 호출처를 한 줄도 안 고치고 따라옵니다. 그래서 실제 작업량은 선언 다섯 곳입니다.

`OpenLink`(`TranslationDetail.tsx:77-95`)는 `Tip`과 같은 일을 손으로 다시 쓴 것이므로 — 그 자리
주석도 *"same as `Tip` and the board's other hover cards"*라고 적고 있습니다 — 이참에 `Tip`으로
접습니다.

다섯 곳이 같은 idiom입니다 — `group`을 타깃에, `absolute … top-full`과 `hidden … group-hover:block`을
패널에. `CollectedBreakdownCard.tsx:11`이 직접 그렇게 선언합니다: *"This is that idiom again, not a
second one."* 그러니 고치는 방식도 하나여야 합니다. 여섯 번째 변종을 만들면 그 주석이 거짓이 됩니다.

`web/src/components/InfoPopover.tsx` 하나로 뽑고 패널에 네이티브 `popover` 속성을 씁니다. 열림은
입력 장치로 갈라지는데,
`matchMedia`가 아니라 이벤트 자체로 판별합니다.

```tsx
onPointerEnter={(e) => { if (e.pointerType !== "touch") show(); }}
onPointerLeave={(e) => { if (e.pointerType !== "touch") hide(); }}
onClick={toggle}   // 터치·키보드 공통 경로
```

`pointerType`이 `(hover: hover)` 미디어쿼리보다 정확합니다. 터치스크린 달린 노트북에서 손가락과
마우스가 각자 맞게 동작합니다.

`popover`를 고른 가장 큰 이유는 **top layer**입니다. 팝오버가 조상의 `overflow`에 잘릴 수 없게 됩니다.
`App.tsx:246`의 긴 주석이 기록한 버그 — 헤더에 `overflow-x-auto`를 넣었더니 `overflow-y`까지 `auto`가
되어 스토리지 팝오버가 모든 폭에서 조용히 잘렸다는 — 이 종류가 구조적으로 사라집니다. 헤더가 지금
사이드 스크롤을 못 쓰고 wrap으로 우회하는 이유도 그것이었습니다. Esc·바깥 탭 닫기·포커스 관리는
공짜로 붙습니다.

폰에서는 `w-72`/`w-80` 고정폭이 화면을 넘치므로 `max-w-[calc(100vw-2rem)]`을 함께 겁니다.

#### 열림 상태의 주인은 React이고, `popover`는 그 위에 얹는다

이 스펙을 승인한 뒤 확인한 제약입니다. **jsdom 30은 popover API를 구현하지 않습니다** —
`element.showPopover`가 `undefined`이고, `element.popover`도 `undefined`이며, `:popover-open`은
매칭되지 않습니다(이 저장소의 `jsdom@30.0.0`에서 직접 확인). 그러므로 열림/닫힘을 DOM의 popover
상태에만 맡기면 web 테스트에서 검증할 수 있는 것이 없어집니다.

그래서 순서를 뒤집습니다. **열림 상태는 `useState`가 들고**, 네이티브 popover는 그 위에 얹는
점진적 향상으로 씁니다.

- 패널의 렌더/숨김은 React 상태가 결정합니다. `:popover-open`에 기대지 않습니다.
- 열 때 `typeof el.showPopover === "function"`을 확인하고 있을 때만 호출합니다. 실제 브라우저에서는
  이것이 패널을 top layer로 올리고, jsdom에서는 `popover` 속성이 통째로 무시되므로 우리 클래스가
  그대로 보이게 합니다. 양쪽 다 동작합니다.
- 브라우저가 자체적으로 닫는 경우(Esc, 바깥 클릭)를 상태에 되돌려 받기 위해 `toggle` 이벤트를
  듣습니다. jsdom에서는 이 이벤트가 오지 않지만, 거기서는 우리 핸들러가 이미 상태를 바꿉니다.

top layer 이득은 실제 브라우저에서 그대로 남고, 테스트는 상태를 통해 가능해집니다.

### 미디어 미리보기는 예외 — 팝오버가 아니라 인라인 확장

`MarkerText`만 다르게 갑니다. 폰에서 `w-80`(320px) 팝오버는 원문을 거의 다 덮는데, 이 미리보기의
용도가 **원문 문장과 사진을 대조하는 것**입니다. 덮으면 목적이 사라집니다.

좁을 때는 라벨을 탭하면 그 자리 아래로 미디어가 펼쳐지는 아코디언으로 갑니다. 판단 기준은 뷰포트가
아니라 원문 pane의 폭이므로 `@container`를 씁니다(규율 3번).

기존 설계에서 살아남아야 하는 것 둘:

- **영상의 지연 마운트**(`MarkerText.tsx:96-119`). 2차 카드는 마커를 열두 개까지 띄우고, `autoPlay`는
  `preload="none"`을 무시하므로 즉시 마운트하면 모든 mp4를 당겨옵니다. `onMouseEnter`가 arm 신호였던
  자리를 탭이 대신합니다.
- **`playsInline`**. 이미 붙어 있고, iOS에서 인라인 재생을 시키는 것이 원래 그 속성의 일입니다.

반대로 `pointer-events-none`과 "`원본 보기`를 호버 타깃 밖에 둔다"(`MarkerText.tsx:48-49`)는 근거가
터치에서 소멸합니다 — 포인터가 이동하다 미리보기를 떨어뜨릴 일이 없습니다. 인라인 모드에서는 적용하지
않습니다.

### `승인됨 ✓` 호버 스왑 → 터치에서는 확인 다이얼로그

`buttonStyles.ts:30`의 `btnApproved`와, 같은 패턴을 인라인으로 복제한
`TranslationDetail.tsx:321-337`. `승인됨 ✓`가 호버 때 `승인 취소`로 바뀝니다.

터치에서 이 패턴은 성립하지 않습니다. 두 라벨을 한 셀에 겹쳐 호버로 바꾸는 것은 호버가 있는 기기
전용이고, 더 나쁜 것은 일부 터치 브라우저가 탭에 `:hover`를 적용한다는 점입니다 — **손가락 아래에서
라벨이 바뀌므로**, 승인 취소를 의도하지 않은 사람이 취소를 누르는 경로가 됩니다.

`pointer-coarse`에서는 `승인됨 ✓`만 보이고, 탭하면 이미 있는 `ConfirmDialog`로 "승인을 취소할까요?"를
띄웁니다. 오탭 방지를 겸하고 새 컴포넌트가 없습니다. 데스크톱 동작은 그대로입니다.

변형은 `pointer-coarse`를 씁니다. 뜻으로만 보면 여기서 묻고 싶은 것은 "이 기기에 호버가 있나"이므로
`(hover: none)`이 더 정확하지만, Tailwind에 그 변형이 없어 `@custom-variant`를 새로 만들어야 합니다.
실무에서 두 조건은 겹치고, 터치 타깃(아래 전역 규칙 절)이 이미 `pointer-coarse`를 쓰므로 어휘를 하나로
두는 편이 낫습니다.

이 패턴이 두 곳에 복제되어 있으므로 `buttonStyles.ts` 쪽으로 합칩니다. 그 파일이 원래 그 일을 하려고
있습니다.

### `title` 툴팁 서른 개는 등급을 나눈다

`OutletCard` 11, `App` 8, `TranslationDetail` 6, 나머지 5. 전부 팝오버로 승격시키지 않고 셋으로
나눕니다.

- **퍼널 안(`App.tsx`)** — 폰에서 퍼널 자체가 숨으므로 손댈 것이 없다.
- **정보가 그것뿐인 경우**(예: `CollectedBreakdownCard.tsx:68`의 원본 ISO) — 팝오버로 승격.
- **왜 비활성인지 설명하는 것**(예: `POSTED_LOCK`) — 툴팁이 아니라 인라인 한 줄. 비활성 버튼은 호버
  대상이 되기도 어렵다.

서른 개의 분류는 구현 때 목록으로 처리합니다. 스펙에 서른 줄을 적는 것은 과합니다.

## 헤더 — 폰만 손댄다

`md:` → `tablet:`이 순수 개명이므로 태블릿에서 바꿀 것이 없습니다. 834px에서 헤더가 두 줄로 접히지만
세로 1112px 화면에서 문제가 아니고, `App.tsx:246`이 기록한 wrap 결정은 이미 옳습니다.

폰에서 두 가지만 줄입니다.

- `TABS`(`App.tsx:25-29`)에 `short`를 더한다 — `1차`, `2차`, `수집`. 그 배열의 주석이 "탭의 네 가지
  사실은 한 곳에 모은다"고 선언하므로, 다섯 번째 사실도 거기 넣는 것이 맞습니다. 렌더는 축약 라벨에
  `tablet:hidden`, 전체 라벨에 `hidden tablet:inline`.
- 로고의 `Review`(`App.tsx:256`)를 `hidden tablet:inline`으로 돌린다.

## 전역 규칙

`styles.css`의 `@layer base`에:

- `word-break: keep-all`과 `overflow-wrap: break-word`를 `body`에. 한국어는 어절 단위로 끊겨야
  읽힙니다. `keep-all`이 단어 안 줄바꿈을 막고, `break-word`가 너무 긴 토큰의 넘침을 막습니다.
  `OutletCard.tsx:644`가 mono/url에 `break-all`을 쓰고 있으므로 그 지점이 유지되는지 확인합니다.

`App.tsx:239`의 `h-screen`을 `h-dvh`로 바꿉니다. 100vh는 모바일 주소창을 계산에 넣지 않습니다.

터치 타깃은 `buttonStyles.ts:9`의 `BASE`에 `pointer-coarse:min-h-11`(44px) **한 줄**입니다.
`btn`·`btnPrimary`·`btnDanger`·`btnApprove`·`btnApproved`가 전부 `BASE`를 공유하므로 한 줄이 보드의
모든 버튼을 고칩니다. `pointer-coarse`는 뷰포트가 아니라 입력 장치를 보므로, 창을 좁힌 데스크톱에서
버튼이 뚱뚱해지지 않습니다. 설치된 Tailwind는 4.3.2이고 이 변형은 v4.1에서 추가되었습니다.

`BASE`를 쓰지 않는 버튼들 — nav 탭(`App.tsx:390`), `게시됨으로`(`TranslationDetail.tsx:233`),
`OutletCard` 내부 몇 개 — 은 구현 때 훑습니다.

### 세이프 에어리어는 넣지 않는다

`index.html:5`의 뷰포트 메타에 `viewport-fit=cover`가 없으므로 브라우저가 이미 노치와 홈 인디케이터를
피한 뷰포트를 줍니다. 그 상태에서 `env(safe-area-inset-*)`는 전부 0이고, 써도 아무 일도 하지 않습니다.
값이 생기게 하려면 `viewport-fit=cover`를 켜야 하는데, 이 앱은 화면 끝까지 칠할 이유가 없습니다.

## 컨테이너 쿼리는 두 곳

`@container`를 붙이는 곳은 `TranslationDetail`의 원문 pane(미리보기 인라인/팝오버 분기)과
`OutletCard`(좁을 때 액션 행 스택)뿐입니다.

`TranslationList`/`RenderingList`에는 **붙이지 않습니다.** 드로우 안에서도 2단에서도 `w-80`이라 폭이
변하지 않습니다. 분기가 필요 없는 곳에 만드는 것은 규율 2번 위반입니다.

## 테스트

jsdom은 레이아웃을 검증할 수 없습니다. 그래서 검증 대상을 **동작**으로 잡습니다 — 기존 web 테스트가
이미 Testing Library 동작 기반이므로 결이 같습니다.

- `ListDetailShell` — ☰ 탭하면 드로우가 열리고, 항목을 탭하면 닫히고, Esc로 닫힌다.
- `InfoPopover` — 클릭으로 열리고 닫힌다. `pointerType: "touch"`인 pointerenter는 열지 않는다.
- `승인됨 ✓` — 탭하면 `ConfirmDialog`가 뜨고, 확인해야 `onUnapprove`가 불린다. (`pointer-coarse`
  자체는 CSS의 일이라 단정하지 않고, 다이얼로그를 경유하는 경로만 검증한다.)
- `TABS` — 축약 라벨과 전체 라벨이 둘 다 DOM에 있다(어느 쪽이 보이는지는 CSS의 일이므로 단정하지
  않는다).
- `MarkerText` — 인라인 모드에서 라벨 탭이 영상을 arm한다(지연 마운트가 유지되는지).

레이아웃은 Playwright로 390 / 834 / 1280 세 폭을 띄워 확인합니다. 768px 상세 pane 448px의 판정도
여기서 합니다.

회귀 가드는 `pnpm test`와 `pnpm typecheck:web`입니다. 브레이크포인트 네 곳의 개명은 어떤 테스트도 그
클래스를 단정하지 않으므로 안전합니다.

## 안 하는 것

- **폰에서 퍼널·sync 칩·시트 링크를 보이게 하는 것.** 오늘도 안 보입니다(`hidden md:flex`). 이 변경이
  만드는 회귀가 아니라 유지되는 현상입니다. 나중에 필요하면 스토리지 팝오버 안에 `tablet:hidden`
  섹션으로 붙일 수 있습니다.
- **다크 모드.** `@theme`의 팔레트가 라이트 전용입니다. 별개의 일입니다.
- **유동 타이포(`clamp()`).** 밀도가 높은 대시보드에서는 단계적 전환이 더 읽힙니다. 필요해지면 그때.
- **`viewport-fit=cover`와 세이프 에어리어.** 위에 근거를 적었습니다.
- **라우팅 변경.** 선택 항목을 URL 해시에 올리지 않습니다. 드로우형은 폰 뒤로가기 의미를 필요로 하지
  않으므로 `selectedId`는 지금처럼 React state로 남습니다.
