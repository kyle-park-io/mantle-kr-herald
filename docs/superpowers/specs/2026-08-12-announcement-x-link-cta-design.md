# 공지의 끝줄은 X로 돌아간다 — 외부 링크 대신 우리 게시물

지금 공지 끝에는 이런 게 붙습니다.

```
거래 방법과 세부 조건은 아래 링크에서 확인하세요.
🔗 https://fluxion.network/trade
```

읽는 사람을 파트너 사이트로 보냅니다. 우리 X 게시물로 보내야 합니다.

```
➡ 자세한 내용은 X에서 확인하세요 (https://x.com/0xMantleKR/status/2087418810458382585)
```

카카오는 `➡` 대신 `👉`를 씁니다.

그리고 X 채널 자체에는 링크 앞 아이콘이 붙으면 안 됩니다 — 이건 이미 규칙인데 지켜지지 않고
있습니다.

## 두 가지 수정

| # | 무엇 | 어디 |
|---|---|---|
| 1 | X 채널 — 링크 앞 아이콘 제거 | `emitters/x.ts` + `conversion/x.md` |
| 2 | 공지 — 외부 링크 CTA → X 링크 CTA | 신규 도메인 함수 + 두 호출부 + `conversion/announcement.md` |

## 1. 아이콘은 코드가 붙인 게 아니다

`🔗`를 넣는 코드는 없습니다. 파이프라인 전체에서 링크를 만지는 건
`canonical.ts:110-116`의 둘뿐이고, 어느 쪽도 앞에 뭘 붙이지 않습니다.

```ts
export function linksToPlain(text: string): string { return text.replace(MD_LINK, "$1 ($2)"); }
export function linksToLabel(text: string): string { return text.replace(MD_LINK, "$1"); }
```

`🔗`는 **변환 에이전트가 쓴 글자**입니다. 그리고 `conversion/x.md:59-66`은 이미 이걸 금지하고
있습니다.

```
링크 앞에 아이콘을 붙이지 않고 URL을 그대로 씁니다.
- ❌ `🔗 https://fluxion.network/trade`
- ✅ `https://fluxion.network/trade`
```

금지 규칙이 명시적으로 적혀 있는데도 `x:2085728188546855340`의 x 렌더링은 `🔗
https://fluxion.network/trade`로 끝납니다. **가이드만으로는 못 막는다는 게 실측으로 확인된
상태**입니다. 그래서 가이드는 그대로 두고(맞는 규칙이니까) 코드 가드를 덧댑니다.

### 규칙

`emitters/x.ts`에서, **줄 전체가 "기호 + URL"인 경우**에만 앞의 기호를 뗍니다.

```
🔗 https://fluxion.network/trade   →   https://fluxion.network/trade
```

건드리지 않는 것:

- `[영상] https://video.twimg.com/...` — 대괄호 라벨. 어차피 `stripMedia`가 emit 전에 걷어내지만
  (`emitters/index.ts:50`), 규칙 자체가 안 무는 편이 안전합니다.
- `· 거래: https://...` — 불릿은 기호지만 URL만 있는 줄이 아니라 문장의 일부인 경우가 있으므로,
  "줄 전체가 기호+URL"이라는 조건이 이걸 가릅니다. 실제로 불릿+URL 단독 줄이면 불릿도 떨어지는데,
  x 채널에서는 그게 의도한 결과입니다.
- 문장 안에 섞인 URL — 줄 전체 조건에 안 걸립니다.
- 텔레그램·카카오·PR — **대상 아님.** 거긴 📢 같은 이모지 스타일이 규칙이고, 새 CTA도 아이콘으로
  시작합니다.

x_paste와 x_typefully는 같은 함수 본체를 공유하므로(`x.ts:52`, `x.ts:59`) 한 곳만 고치면 둘 다
적용됩니다.

## 2. 공지 CTA

### 왜 렌더 시점에 못 넣나

`ConvertTick`은 `rendered`에서 멈춥니다 — "Nothing here publishes or sends"
(`ConvertTick.ts:16-20`). X 게시물 URL은 그 뒤에 생깁니다.

```
convert → format        ← renderings.text 가 여기서 확정된다
  → 2차 검수 (사람)
  → send:channels → Typefully 예약 (publish_at = now + 2분)
  → ReconcilePublished → deliveries.url 에 x.com URL
  → (또는 수동 게시) x:reconcile → translations.posted_url
```

게시 후 재렌더링도 막혀 있습니다. `FormatVariants.ts:120-121`이 `posted` 아이템을 걸러내고
`:172-174`에서 쓰기를 건너뜁니다. **렌더 시점에 URL을 넣을 방법은 없습니다.** 그러므로 발송
시점에 조립합니다.

### 나가는 길이 두 개다

카카오 아울렛은 둘 다 `delivery: "manual"`입니다 — kakao-blockchain, kakao-kol
(`outlet/models.ts:45-46`). `SendChannels`는
`deliveredByChannelSender`로 `auto`만 거르므로(`outlet/models.ts:86-88`), **카카오는 봇 발송
경로를 아예 타지 않습니다.** 사람이 대시보드 [복사]로 퍼갑니다.

| 아울렛 | 채널 | delivery | 나가는 길 |
|---|---|---|---|
| tg-community, tg-dev | telegram | auto | `SendChannels` |
| tg-blockchain, tg-kol | telegram | manual | [복사] → `/emissions` |
| kakao-blockchain 등 | kakao | manual | [복사] → `/emissions` |

두 길 모두에 CTA가 붙어야 하고, 둘이 다른 글자를 내면 그게 바로 버그입니다. 그래서 **순수 함수
하나**를 두고 양쪽이 부릅니다.

### 함수

```
xLinkCta(type, channel, xUrl) → string | null
```

- `type !== "announcement"` → `null`
- `channel`이 `telegram`도 `kakao`도 아니면 → `null`
- 아이콘: `telegram → ➡`, `kakao → 👉`
- 반환: `<아이콘> 자세한 내용은 X에서 확인하세요 (<xUrl>)`

마크다운 링크(`[라벨](url)`) 형태로 만들지 **않습니다.** 그 형태면 `emitTelegramBot`이
`MD_LINK`를 `<a href>`로 바꿔(`telegram.ts:44-46`) URL이 안 보이는 하이퍼링크가 됩니다. 스펙은
괄호 안에 URL이 보이는 형태이므로 리터럴로 씁니다. `문구 (url)`은 `MD_LINK`에 안 걸리므로 emit을
그대로 통과합니다.

### 붙이는 지점

**둘 다 emit 앞**입니다. 뒤에 붙이면 `SendChannels.ts:230-241`의 길이 초과 fail-fast가 CTA를 못
세고, 텔레그램 4096자를 넘긴 채로 나갑니다.

| 호출부 | 위치 |
|---|---|
| `SendChannels.ts` | `resolve`(:151)와 `emit`(:229) 사이 |
| `apiHandlers.ts` | `emitAll` 호출 앞 (:594, :607) |

### URL은 어디서 오나

우선순위대로:

1. `translations.posted_url` — 수동 게시 후 `x:reconcile`/`x:link`가 채웁니다
   (`RetireTranslation.ts:136`).
2. `deliveries`의 `x-post` 아울렛 행 `url` — 봇 발송 후 `ReconcilePublished.ts:71-73`이 채웁니다.

2번은 **검증이 필요합니다.** `SendChannels.ts:301`이 처음 넣는 값은 Typefully의 share_url이고,
x.com URL로 바뀌는 건 리컨사일 후입니다. 그러므로 `https://x.com/` 로 시작하는지 확인하고, 아니면
없는 것으로 칩니다.

### 없으면 막는다

둘 다 없으면 **발송하지 않습니다.** 길이 초과와 같은 처리 — `failures`에 넣고 `failed += 1`,
메시지는 "X 게시물 URL이 없습니다 — X를 먼저 게시하세요".

CTA 없이 내보내는 선택지도 있었지만, 그러면 "링크 없는 공지"가 조용히 나갑니다. 공지의 목적이
X로 보내는 것인데 그게 빠진 걸 아무도 모르는 게 더 나쁩니다.

[복사] 경로는 발송이 아니라 미리보기이므로 막지 않습니다. URL이 아직 없으면 그 자리에
자리표시자를 넣고, 화면에 "X 게시 후 채워짐"으로 표시합니다. 사람이 붙여넣기 전에 X를 먼저
올리게 되는 순서 강제입니다.

## 3. 가이드

에이전트가 계속 외부 링크 CTA를 쓰면 CTA가 두 개 붙습니다. 막아야 합니다.

- `conversion/announcement.md:165` — 이모지 목록에서 `🔗 링크`를 뺍니다.
- `conversion/announcement.md` — 끝에 외부 링크 CTA를 쓰지 말라는 규칙을 추가합니다. 링크는
  코드가 붙인다는 사실까지 적습니다.
- `conversion/few-shot.announcement.json:4, :9, :24` — 세 타깃이 `\n🔗 <url>`로 끝나 에이전트에게
  바로 그 패턴을 가르치고 있습니다. 지웁니다. **가이드보다 few-shot이 셉니다** — x.md가 금지한
  패턴이 x 렌더링에 나온 것도 이런 종류의 불일치가 원인일 수 있습니다.

## 이미 저장된 렌더링은 안 고친다

가이드를 고쳐도 `renderings` 테이블에 이미 든 공지는 안 바뀝니다. 그것들은 끝에 옛 CTA를 달고
있고, 발송하면 CTA가 두 개 나갑니다.

코드가 발송 시점에 꼬리를 잘라내게 할 수도 있지만 **하지 않습니다.** "끝에 붙은 URL 줄"을
기계적으로 지우는 규칙은 본문에 의미 있는 외부 링크가 있는 공지까지 자릅니다. 어느 링크가 CTA고
어느 게 본문인지 코드가 알 방법이 없습니다.

기존 건은 2차 검수에서 사람이 지웁니다. 어차피 사람 검수를 거치는 물건이고, 앞으로 나올 것들은
가이드와 few-shot이 막습니다.

## 테스트

| 무엇 | 어디 |
|---|---|
| 아이콘 제거 규칙 (뗄 것 / 안 뗄 것) | `tests/domain/formatting/emitters/x.test.ts` |
| `xLinkCta` 순수 함수 — 타입·채널·아이콘 분기 | 신규 |
| CTA가 길이 계산에 포함됨 | `tests/app/sendChannels.test.ts` |
| URL 없으면 발송 차단 | `tests/app/sendChannels.test.ts` |
| share_url은 URL로 안 침 | `tests/app/sendChannels.test.ts` |
| 미리보기와 발송본이 같은 글자 | `tests/adapters/web/apiHandlers.test.ts:516-580` |
| 공지 아닌 타입엔 안 붙음 | 신규 |

`tests/app/sendChannels.test.ts:192`는 **진짜** `emitTelegramBot`을 물려 돌리므로(:193-195 주석),
CTA가 길이에 들어가는지 여기서 실측됩니다.

## 범위 밖

- 기존 렌더링 일괄 수정 — 위 참조.
- x 채널 CTA — X 게시물이 자기 자신을 링크할 수 없습니다.
- PR 메일 — 보도자료는 성격이 다릅니다.
- 해설·캐주얼·KOL — 공지만입니다.
