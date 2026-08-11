# 링크 수집 — 타임라인이 물어다 주는 것 말고, 우리가 고른 글

지금 파이프라인에 글이 들어오는 길은 하나입니다. `herald-watch`가 두 시간마다 `pnpm collect`를
돌려 `Mantle_Official` 타임라인을 훑고, 새 스레드를 `x_threads`에 넣습니다. 소스 계정은
`src/cli/collect.ts:15`에 문자열 리터럴로 박혀 있습니다 — 환경변수도, 설정 파일도 없습니다.

그래서 "이 글도 우리가 번역해서 내보내면 좋겠는데"라고 판단한 글이 그 계정 바깥에 있으면, 지금은
파이프라인에 넣을 방법이 없습니다. 터미널을 열어도 없습니다 — `pnpm collect <handle>`은 그 계정
타임라인을 통째로 훑지, 글 하나를 집어 오지 않습니다.

이 문서는 대시보드에 세 번째 탭을 붙여, x.com 링크 하나를 붙여넣으면 그 글이 **타임라인이 물어다
준 글과 구별 없이** 같은 레일에 오르게 합니다.

## 범위

- 링크 하나 → `x_threads` 행 하나. 여기서 끝납니다.
- 그 뒤는 지금과 완전히 같습니다. `herald-watch`(2시간마다 `*:17`)가 `translate:prepare`로 번역
  초안을 만들고, 1차 검수에 뜨고, 승인하면 `herald-convert`(30분마다 `*:07,37`)가 채널 문구를
  만들고, 2차 검수에 뜹니다. 사람 검수 게이트 두 개는 그대로입니다.
- 로컬(`pnpm serve`)과 호스팅(Vercel) 양쪽에서 동작합니다.

## 부품은 이미 다 있다

새로 만드는 건 그 부품들을 잇는 유스케이스 하나뿐입니다.

| 필요한 것 | 이미 있는 것 |
|---|---|
| URL → 트윗 id | `parsePostUrl` (`src/domain/publish/xReconcile.ts:183`) |
| id → 스레드 전체 | `SourceGateway.fetchThread` (`src/adapters/twitterapi/TwitterApiSourceGateway.ts:88`) |
| 아티클 본문 | `SourceGateway.fetchArticle` (`:118`) |
| 트윗 배열 → 스레드 | `assembleThreads` (`src/domain/threadAssembler.ts:7`) |
| 저장 (재수집 안전) | `CollectionRepository.upsert` — `on conflict (root_id) do update` (`src/adapters/store/PgCollectionRepository.ts:107`) |

`fetchThread`는 이미 `pnpm x:link`가 실전에서 쓰고 있습니다(`src/cli/x-link.ts:84`). 검증되지 않은
경로는 없습니다.

## 워터마크를 건드리지 않는다

`pnpm collect`는 "어디까지 읽었나"를 `output/x/state.json`에 들고 돕니다
(`src/cli/collect.ts:42`, `LocalJsonStore(paths.xDir)`). 링크 수집이 이걸 앞으로 밀면 정기 수집이
그 사이의 글을 영영 건너뜁니다.

밀 이유가 없습니다. 워터마크는 "타임라인을 어디까지 훑었나"를 뜻하는데, 링크 수집은 타임라인을
훑지 않습니다. `CollectAuthoredContent`도 `--since`/`--limit`가 붙은 adhoc 실행이면 워터마크
전진을 통째로 건너뜁니다(`src/app/CollectAuthoredContent.ts:74-79`) — 같은 판단입니다.

런 원장(`output/x/runs.json`)도 마찬가지로 안 씁니다. 이 둘을 안 건드리는 덕에 **링크 수집 경로는
파일시스템을 전혀 만지지 않고**, 그래서 읽기 전용 FS인 Vercel 함수 안에서 그대로 돕니다. 이게
"대시보드가 직접 가져온다"를 성립시키는 조건입니다.

## 유스케이스 — `src/app/CollectLinkedThread.ts` (신규)

의존은 `SourceGateway`, `CollectionRepository`, `TranslationStore` 셋입니다 —
`PrepareTranslations`(`src/app/PrepareTranslations.ts:33`)가 쓰는 것과 같은 조합이고, 같은
이유입니다. 셋째는 `listTranslatedIds()`(`src/ports/TranslationStore.ts:6`) 하나만 쓰며, "이미
번역됨"과 "이미 대기 중"을 가르는 데만 필요합니다. 단위 테스트는 가짜 셋으로 끝납니다.

```
run(url):
  parsed = parsePostUrl(url)                    → 없으면 거절: bad-url
  tweets = gateway.fetchThread(parsed.rootId)   → 비면 거절: not-found
  아티클인데 blocks 없으면 gateway.fetchArticle(id)로 채움
  thread = assembleThreads(tweets) 중 rootId가 parsed.rootId인 것
                                                → 없으면 거절: not-found
  첫 트윗이 isCommenterReply면 거절: reply
  itemId = `x:${parsed.rootId}`
  이미 있었나 = repo.loadAll()에 rootId가 있나        (upsert 전에 읽음)
  이미 번역됐나 = translationStore.listTranslatedIds()에 itemId가 있나
  repo.upsert([thread])                          ← 어느 경우에도 실행: 본문·미디어 갱신
  → { itemId, tweets: n, outcome }
```

`outcome`이 `already-*`여도 `upsert`는 그대로 돕니다. 재수집은 안전하고
(`PgCollectionRepository.ts:107`의 `on conflict do update`), 아티클 본문은 `mergeTweet`
(`:41-45`)이 지켜 주므로, 다시 던진 링크가 그 사이 늘어난 스레드 꼬리를 데려옵니다.

작성자 필터는 넣지 않습니다. `flattenXThreads`(`src/adapters/content/XContentSource.ts:116-131`)에
작성자 조건이 없어서, 어느 계정 글이든 그대로 파이프라인을 탑니다 — 이 기능이 원하는 동작 그대로입니다.

### `isCommenterReply`를 입구에서 거절하는 이유

`flattenXThreads:128`은 첫 트윗이 `@`로 시작하는 답글인 스레드를 **말없이 버립니다.** 그대로 두면
사용자는 "수집됨"을 보고, 두 시간을 기다리고, 1차 검수를 열고, 거기 없는 걸 발견합니다. 수집은
정말 성공했으므로 어디에도 오류가 남지 않습니다.

그래서 저장 직전에 같은 술어로 검사해 입구에서 거절합니다. 술어는 이미
`isCommenterReply`(`XContentSource.ts:37`)로 export돼 있으므로 규칙을 복사하지 않고 그것을
가져다 씁니다 — 복사본은 원본과 갈라지고, 갈라지면 화면이 아무 코드도 동의하지 않는 판정을
내놓습니다.

## 라우트 — `/api/intake/*`

라우트는 둘입니다: 넣는 `POST /api/intake/x`와, 대기 목록을 읽는 `GET /api/intake/pending`
(아래 "대기 목록" 참고). 둘 다 `handleApi`(`src/adapters/web/apiHandlers.ts:261`) 안에 넣습니다. 라우트 테이블이 하나뿐이고
Vercel 엔트리(`src/vercel/entry.ts:29-31`)가 이걸 import로 재사용하므로, 한 번 추가하면 양쪽에
동시에 삽니다. `vercel.json:11-16`의 `/api/(.*)` 리라이트도 그대로 걸립니다.

세션 게이트는 `:278`의 선검사(`if (!isLogin && !deps.session) return 401`)가 자동으로 덮습니다.

요청 `{ url: string }`. 응답 `{ itemId, outcome, tweets }`, `outcome`은 셋 중 하나:

| `outcome` | 뜻 |
|---|---|
| `collected` | 새로 들어왔습니다 |
| `already-pending` | 이미 수집됐고 아직 번역 안 됐습니다 |
| `already-translated` | 이미 번역돼 1차 검수에 있습니다 |

거절은 400 + 메시지입니다(`refuse()` 관례, `apiHandlers.ts:612`).

### capability 게이트

`TWITTERAPI_IO_KEY`가 없는 배포에서는 `loadConfig()`(`src/config.ts:11`)가 던집니다. 이게
`createDeps` 전체를 무너뜨리면 안 됩니다.

`reconcilePublished`(`createDeps.ts:627-643`)와 `headroomReader`가 쓰는 모양을 그대로 따릅니다 —
게이트웨이 생성을 자체 try/catch로 감싸고, 실패하면 `collectLinkedThread` dep을 **아예 넣지
않습니다.** 라우트는 `if (!deps.collectLinkedThread)`로 먼저 걸러 400을 답합니다
(`sendToOutlet`의 `:640`과 같은 모양).

같은 불리언을 `StatusView.intakeEnabled`로 실어 보냅니다(`apiHandlers.ts:66`의 `sendsEnabled`
옆, `web/src/types.ts:307` 옆). `sendsEnabled`/`conversionEnabled`가 그렇게 하는 이유와 같습니다:
**버튼과 라우트가 어긋날 수 없게** 하나의 값에서 둘 다 끌어옵니다.

## 화면 — `#intake` 탭 "링크 수집"

`web/src/components/IntakeView.tsx` (신규). `RenderingsView`의 prop 모양(`onDirtyChange`,
`authEpoch`)을 따릅니다.

- URL 입력창 + `[넣기]`
- 결과 한 줄 — 위 `outcome` 또는 거절 문구
- **대기 목록** — 수집됐지만 아직 번역 초안이 없는 항목들

### 대기 목록이 있어야 하는 이유

링크를 넣은 항목은 번역 행이 생기기 전까지 `GET /api/translations`에 **잡히지 않습니다.**
1차 검수 목록은 `translations` 테이블에서 나오고, 그 행은 `translate:save`가 씁니다. 즉 제출
직후 1차 검수를 열면 아무것도 없고, 최대 두 시간 뒤에야 나타납니다.

대기 목록이 없으면 이 기능은 "넣었는데 사라짐"으로 읽힙니다. 목록은 이미 계산되고 있는 것을
보여 줄 뿐입니다 — `PgXContentSource.loadPending`(`src/adapters/store/PgContentSource.ts:32`)이
`translations`에 없는 `x_threads` 행을 정확히 그렇게 고릅니다. 다음 틱 시각(`*:17`)도 같이
적어, 기다리는 시간이 고장이 아니라 일정이라는 걸 화면에서 알 수 있게 합니다.

`GET /api/intake/pending`이 이걸 답합니다. 항목당 `{ itemId, text, createdAt, kind }`만 — 즉
`ContentItem`에서 화면에 필요한 것만 추려 보냅니다. `POST /api/intake/x`의 응답에도 갱신된 같은
목록을 실어, 제출 직후 화면이 한 왕복으로 스스로 맞습니다(`sendToOutlet`이 `board`를 함께
돌려주는 관례, `apiHandlers.ts:666`). 이 라우트는 X 게이트웨이를 안 쓰므로
`TWITTERAPI_IO_KEY` 없는 배포에서도 동작합니다 — 키가 없어 넣지는 못해도 밀린 것은 보입니다.

목록은 링크로 들어온 것만이 아니라 대기 중인 전부를 보여 줍니다. 출처로 나누려면 새 컬럼이
필요한데, 나눠서 얻는 게 없습니다 — 두 종류는 정확히 같은 대우를 받아야 하고, 그게 이 기능의
요구사항입니다.

### 출처 표시는 하지 않는다

링크로 들어온 글이 다른 계정 것이어도 1차 검수에서 따로 표시하지 않습니다. `itemUrl()`
(`web/src/types.ts:2`)이 `https://x.com/i/status/<id>`를 만들고 이 형태는 핸들 없이 열리므로,
검수자는 이미 원문을 눌러 확인할 수 있습니다.

## 거절 문구

조용히 실패하는 길을 남기지 않는 것이 이 표의 목적입니다.

| 상황 | 문구 |
|---|---|
| x.com 링크 형식 아님 | `x.com/<계정>/status/<번호> 형태의 주소가 필요합니다` |
| 스레드 없음(삭제·비공개) | `그 글을 가져올 수 없습니다 — 삭제됐거나 비공개일 수 있습니다` |
| 첫 트윗이 남의 대화에 단 답글 | `이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다` |
| 이미 수집됨, 번역 대기 | `이미 들어와 있습니다 — 다음 번역 틱에서 처리됩니다` |
| 이미 번역됨 | `이미 번역돼 1차 검수에 있습니다` |
| X API 실패 | 게이트웨이 오류 메시지 그대로 |
| `TWITTERAPI_IO_KEY` 없는 배포 | `이 배포에는 TWITTERAPI_IO_KEY가 없어 링크 수집을 할 수 없습니다` |

마지막 줄은 버튼 옆 Tip으로도 나갑니다 — 눌러 보고 알아내는 게 아니라 누르기 전에 보입니다.

## 곁다리 — 탭 정의를 한 곳으로

`App.tsx`의 탭 정의가 다섯 곳에 흩어져 있습니다: `Mode` 유니온(`:12`), `modeFromHash`(`:22`),
`switchMode`의 해시 삼항(`:88`), nav의 인라인 `as const` 배열(`:345`), 2갈래 삼항 렌더(`:468`).
세 번째 탭은 다섯 곳을 다 고쳐야 하고, `modeFromHash`는 `#renderings`가 아닌 **모든** 해시를
`translations`로 접기 때문에 한 곳만 빠뜨려도 새 탭이 조용히 1차 검수로 튕깁니다.

`{ id, hash, label }` 테이블 하나로 합치고 나머지 넷을 거기서 끌어 씁니다. 이 작업에 필요한
만큼이고, `App.tsx`의 다른 것은 건드리지 않습니다.

## 테스트

- `tests/app/collectLinkedThread.test.ts` (신규) — 거절 네 갈래(`bad-url`, 빈 스레드, 루트 불일치,
  답글) + 게이트웨이가 던질 때 + `outcome` 세 갈래 + 재수집이 아티클 본문을 지우지 않는지
- `tests/adapters/web/gate.test.ts` — `POST /api/intake/x`는 `writeRoutes`에,
  `GET /api/intake/pending`은 `readRoutes`에. 세션 검사 없는 라우트는 여기서 터집니다 — 추가는
  선택이 아닙니다.
- `tests/adapters/web/apiHandlers.test.ts` — dep 있을 때/없을 때, 거절이 400인지
- `tests/support/fakeApiDeps.ts` — `collectLinkedThread` 필드
- `web/tests/IntakeView.test.tsx` (신규) — `stubFetch` 관례, 사용자에게 보이는 한국어로 단언
- `web/tests/App.test.tsx` — `IntakeView`를 `vi.mock`(마운트 카운터 포함), `stubFetch`에 갈래 추가,
  `#intake` 해시 전환
- `tests/web/typeMirror.test.ts` — `StatusView.intakeEnabled` 쌍

## 배포

Vercel 환경변수에 **`TWITTERAPI_IO_KEY`** 를 넣어야 합니다. 안 넣으면 탭은 뜨고 버튼은 비활성이며
이유가 보이는 상태로 배포됩니다 — 배포가 깨지지는 않습니다.

`.env.example`의 §2 수집 절에 이 변수가 이제 호스팅 배포에도 필요하다는 것을 적습니다.

## 안 하는 것

- **Lark 링크 수집.** 이 탭은 x.com 전용입니다.
- **여러 링크 한 번에.** 한 번에 하나. 배치가 필요해지면 그때 만듭니다.
- **링크로 들어온 항목에 표식.** 위 "출처 표시는 하지 않는다" 참고.
- **수집 요청 이력 테이블.** 대기 목록이 이미 "지금 어디까지 왔나"를 답합니다.
- **`pnpm collect`의 하드코딩된 `Mantle_Official` 손보기.** 정기 수집의 대상 계정은 이 작업과
  무관합니다.
- **번역을 즉시 돌리기.** `translate:prepare`는 로컬 에이전트가 필요해 호스팅에서 못 돕니다
  (`docs/ko/capabilities.md` §3). 링크로 들어온 글도 타임라인 글과 같이 다음 틱을 기다립니다.
