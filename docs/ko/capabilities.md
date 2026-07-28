# 무엇을 할 수 있는가 (capabilities.md)

이 문서는 `mantle-kr-herald`가 무엇을 하는 프로젝트인지, 파이프라인이 어떤 단계로 구성되어 있는지,
그리고 무엇을 의도적으로 하지 않는지를 설명합니다. 각 명령이 정확히 무엇을 읽고 쓰는지는
[`artifacts.md`](artifacts.md)를, 처음 설치해서 써 보는 절차는 [`quickstart.md`](quickstart.md)를,
팀 내부 운영 절차는 [`team-runbook.md`](team-runbook.md)를 참고하세요.

## 1. 한 문단 요약

`mantle-kr-herald`는 Mantle KR 팀의 소셜 미디어 콘텐츠 파이프라인입니다. X(트위터, 기본
`Mantle_Official`)와 사내 Lark 그룹 채팅에서 원문을 수집하고, 로컬 Claude Code 에이전트가
워크시트를 채우는 방식으로 한국어로 번역한 뒤, 승인된 번역을 채널(`x`/`telegram`/`kakao`/`pr_mail`)에
맞게 변환·포맷하고, 사람이 두 차례(1차: 번역, 2차: 채널 포맷) 검수·승인한 결과만 저장 모드에 따라
Google Drive/Lark Drive 또는 로컬 폴더(`output/publish/local/`)에 올립니다. 승인된 텔레그램·X
렌더링은 `pnpm send:channels`로 실제 채널에도 보낼 수 있습니다(§8). `cloud` 모드에서는
Google Sheet에 게시 이력도 남깁니다. 모든 단계는 개별 CLI 명령(`pnpm <script>`)으로 실행되며,
자동으로 다음 단계가 실행되지 않습니다 — 사람이 각 단계 사이를 직접 잇습니다.

## 2. 파이프라인

```
[수집]        pnpm collect, pnpm collect-lark
   │
   ▼
[번역]        pnpm translate:prepare → (로컬 에이전트가 워크시트 작성) → pnpm translate:save
   │         (선택) pnpm translate:align → (로컬 에이전트가 선례에 맞춰 다듬음) → pnpm translate:save
   ▼
[1차 검수]    pnpm serve  (번역 검수 모드)
   │
   ▼
[변환]        pnpm convert:prepare → (로컬 에이전트가 워크시트 작성) → pnpm convert:save
   │
   ▼
[채널 포맷]   pnpm format → pnpm format:save
   │
   ▼
[2차 검수]    pnpm serve  (채널 검수 모드)
   │
   ▼
[채널 발송]   pnpm send:channels  (텔레그램/X로 실제 발송)
   │
   ▼
[발행]        pnpm drive:publish  (Drive 또는 로컬 폴더로)
   │
   ▼
[기록]        pnpm history:record
```

화살표는 데이터가 다음 단계의 입력이 된다는 뜻일 뿐 자동 트리거가 아닙니다 — 각 명령은 사람이 직접
실행합니다. 각 명령이 정확히 무엇을 읽고 쓰는지는 [`artifacts.md`](artifacts.md)의 "명령어별
입출력" 표를 참고하세요.

## 3. 지원 범위

*(참고 — 이 문서 여러 곳에서 괄호 안에 단독으로 나오는 `§N`(예: §6, §9b)은 이 문서 자신의 절
번호가 아니라 원래 프로젝트 제안서의 모듈 번호입니다. `CHANGELOG.md`와 코드 주석이 같은 번호를
그대로 쓰고 있어 여기서도 표기를 남겨 둡니다. 이 문서의 절을 가리킬 때는 언제나
`[capabilities.md] §N`처럼 문서 이름과 함께 씁니다.)*

**소스**
- X (트위터) — 지정한 계정의 게시물을 스레드 단위로 재구성해 수집. **X 아티클은 본문까지 받아
  마크다운으로 변환합니다** (게시물 본문이 링크 한 줄만 들어오던 문제를 해결) (`pnpm collect`)
- Lark 그룹 채팅 — 설정된 채팅방들의 텍스트/포스트 메시지를 채팅방별로 수집 (`pnpm collect-lark`)

**채널** (§6 채널 포맷 대상, 검수·승인의 단위): `x` · `telegram` · `kakao` · `pr_mail`

**목적지(destination)** — 같은 채널이라도 사람이 손으로 붙여넣느냐 봇/API가 그대로 보내느냐에 따라
철자가 달라지므로, 채널마다 실제로 쓸 수 있는 목적지가 정해져 있습니다(총 6개):

| 채널 | 목적지 |
|---|---|
| `x` | `x_paste`(붙여넣기) · `x_typefully` |
| `telegram` | `telegram_paste`(붙여넣기) · `telegram_bot`(HTML) |
| `kakao` | `kakao_paste`(붙여넣기) |
| `pr_mail` | `pr_mail` |

승인(approve)은 여전히 **채널 단위로 한 번**만 이루어집니다 — 목적지는 별도로 승인되지 않고, 승인된
채널의 canonical 텍스트로부터 대시보드가 요청 시점에 계산해 보여 줍니다
(`GET /api/renderings/:itemId/:type/:channel/emissions`, [`artifacts.md`](artifacts.md) §3 참고).

**저장소**: `cloud` 모드에서는 Google Drive와 Lark Drive(+ 데이터 허브인 Google
Sheet — `targets`/`history` 탭), `local` 모드에서는 로컬 폴더
`output/publish/local/`(업로드 대상 목록은 [`artifacts.md`](artifacts.md) 참고). Google Sheet는
`cloud` 모드 전용입니다

## 4. 할 수 없는 것

이 프로젝트가 실제로 하지 않는 일은, 하는 일 만큼 분명하게 알아야 합니다.

- **승인(approve)은 그 자체로 아무것도 전송·업로드하지 않습니다.** 승인 경로(`SaveTranslation`,
  `ApproveRendering`)는 상태를 `approved`로 바꿀 뿐입니다 — 실제 업로드·전송은 항상 사람이 별도
  명령을 실행해야 일어납니다. `pnpm drive:publish`(또는 대시보드의 게시 버튼)는 저장 모드에 따라
  Google/Lark Drive(`cloud`) 또는 로컬 폴더 `output/publish/local/`(`local`)에 **기록을 보존**할
  뿐, 그 자체로 X/텔레그램/카카오 같은 실제 채널에 올라가는 것은 아닙니다 — 실제 채널 전송은 아래
  §8의 `pnpm send:channels`(텔레그램·X 한정) 몫입니다. 저장 모드별 게이팅은
  [`artifacts.md`](artifacts.md)의 "저장 모드" 절을 참고하세요.
- **카카오·메일(`pr_mail`)로는 여전히 자동 전송이 없습니다.** `pnpm send:channels`(§8)가 실제로
  전송하는 채널은 텔레그램·X 두 개뿐입니다 — `kakao_paste`·`pr_mail` 목적지는 여전히 그 앱이
  받아들이는 텍스트를 만들어 줄 뿐이고, 사람이 대시보드에서 복사해 직접 붙여넣거나 보내야 합니다.
- **스레드를 자동으로 나누지 않습니다.** X 목적지에서 세그먼트 하나가 가중치 한도(280, 순수 한글
  기준 140자)를 넘어도 경고(`overLimit`)만 남길 뿐 잘라내지 않습니다 — 실제로 나누는 것은
  `pnpm format --refine` 워크시트를 채우는 작성자입니다.
- **Typefully 붙여넣기 동작은 아직 실검증되지 않았습니다.** `x_typefully`는 현재 `x_paste`와 동일한
  텍스트를 냅니다. Typefully 에디터가 붙여넣은 텍스트에서 트윗 경계를 어떻게 처리하는지 1차 문서로
  확인된 바가 없어서입니다 — 실제 에디터에 canonical 초안을 붙여넣어 확인하기 전까지는 신뢰하지
  마세요. (이 우려는 사람이 손으로 붙여넣는 경우에만 해당합니다 — §8 `pnpm send:channels`는
  Typefully 에디터에 붙여넣지 않고, 세그먼트를 그대로 API의 `posts` 배열로 보내므로 이 문제를
  겪지 않습니다.)
- **번역과 변환은 로컬 Claude Code 에이전트가 워크시트를 채우는 방식입니다 — 이 프로젝트는 Claude
  API를 호출하지 않습니다.** `pnpm translate:prepare`/`pnpm convert:prepare`가
  `output/*/worksheets/batch-<타임스탬프>.md` 워크시트를 만들면, 로컬 에이전트가 그 안의 번역/변환
  섹션을 채우고 `pnpm translate:save`/`pnpm convert:save`로 저장합니다. 코드베이스 어디에도
  Anthropic/Claude API 키나 호출이 없으며, 자율적으로 번역이 이루어지는 경로는 없습니다.
- **모든 실행은 한 명의 운영자의 로컬 머신에 한정됩니다.** `pnpm serve`가 띄우는 검수 대시보드도
  `127.0.0.1`(로컬호스트)에만 바인딩되는 로컬 웹 서버이며, 로그인·세션·다중 사용자 개념이 없습니다.
  공유 서버나 상시 구동되는 런타임은 없습니다.
- **Lark는 아직 채널 포맷 대상이 아닙니다.** §6 채널 포맷은 `x` · `telegram` · `kakao` ·
  `pr_mail` 네 개만 지원합니다(`Channel` 타입). `pnpm lark:send`가 존재하지만, 이는 `--text`
  인자를 그대로 전송하는 독립적인 메시지 전송 명령일 뿐 파이프라인 콘텐츠(번역/변환/포맷 결과)와
  연결되어 있지 않습니다.
- **임프레션(§9b ③)은 X만 지원합니다.** `pnpm impressions:record`가 `history` 탭의 `channel=x`
  행을 트윗 조회해 `impressions`(viewCount)/`impressionsAt` 두 컬럼(H·I)을 채웁니다 —
  `pnpm history:record`는 A~G만 쓰고 이 두 컬럼은 §9b 몫으로 비워두기 때문입니다. 텔레그램/카카오
  등 다른 채널은 임프레션 소스가 없어 빈 채로 남고, 아직 라이브 미검증입니다(`spreadsheets` 스코프
  필요 — §9a와 동일).

## 5. 모듈 지도

| 모듈 | 무엇을 하는가 | 주요 명령 | 관련 문서 |
|---|---|---|---|
| **A. X 데이터 수집** | twitterapi.io로 지정한 계정의 트윗을 스레드 단위로 재구성해 증분 수집하고, 삭제된 트윗을 소프트 마크로 반영. X 아티클은 본문(Draft.js 블록)을 별도로 받아 마크다운으로 변환 | `pnpm collect [handle]`, `pnpm reconcile` | — |
| **B. Lark 데이터 수집** | 지정한 Lark 그룹 채팅들의 텍스트/포스트 메시지를 채팅방별로 증분 수집 | `pnpm collect-lark` | [`setup/lark.md`](setup/lark.md) |
| **C. 한국어 번역** | 수집된 X/Lark 콘텐츠로 번역 워크시트를 만들고, 로컬 에이전트가 채운 한국어 번역을 저장. 승인 시 few-shot 예시로 승격. `translate:align`(선택)은 `translate:save`와 1차 검수 사이에서 초안을 가장 가까운 TM 선례에 맞춰 다듬음 | `pnpm translate:prepare`, `pnpm translate:save`, `pnpm translate:align`, `pnpm glossary` | — |
| **D. Drive 업로드** | 승인/번역 완료된 결과를 마크다운으로 저장 — `cloud` 모드면 Google Drive와 Lark Drive에 업로드, `local` 모드면 `output/publish/local/{review,approved}/`에 파일로 저장(발송된 렌더링의 2차 완성본은 `sent/`에 별도로 best-effort 아카이브 — §8 참고) | `pnpm drive:publish`, `pnpm drive:init`, `pnpm google:auth` | [`setup/README.md`](setup/README.md), [`setup/google-drive.md`](setup/google-drive.md), [`setup/lark.md`](setup/lark.md) |
| **E. 검수 대시보드** | 번역(1차)·채널 포맷(2차)을 검수·수정·승인·발행하는 로컬 웹 대시보드 | `pnpm serve`, `pnpm build:web`, `pnpm dev:web` | — |
| **F. 콘텐츠 가공** | 승인된 번역을 §5 항목 변환(타입별 X/공지/해설/소통/KOL/PR)과 §6 채널 포맷(코드 변환 + 선택적 에이전트 다듬기) 두 단계로 채널용 게시물로 가공 | `pnpm convert:prepare`, `pnpm convert:save`, `pnpm format`, `pnpm format:save` | — |
| **G. Google Sheet 데이터 허브** | 팀이 함께 편집하는 배포 대상 목록(`targets` 탭)과 게시 이력(`history` 탭) 관리 | `pnpm sheet:init`, `pnpm targets:list`, `pnpm history:record` | [`external-integrations.md`](../architecture/external-integrations.md) |
| **H. 번역 메모리** | `@0xMantleKR`과 `Mantle_Official`의 실제 승인 EN↔KO 번역 쌍을 발굴해 사람 확인을 거쳐 번역 few-shot에 반영 | `pnpm collect:reference`, `pnpm tm:measure`, `pnpm tm:pair`, `pnpm tm:promote` | — |
| **I. X 성과 지표** | 사람이 관리하는 `KOL list` 탭(X 행만)을 읽어 KR 공식 계정과 각 X KOL의 팔로워·해당 월 게시물을 조회하고, 원시 성과 숫자를 기계 전용 `x-performance` 탭에 월별로 upsert | `pnpm metrics:record [--month YYYY-MM]` | — |
| **J. 채널 발송** | 승인된 채널 렌더링(텔레그램·X)을 실제 API로 발송 — 텔레그램은 봇 API, X는 Typefully 경유(공식 API·twitterapi.io 쓰기 없음). 로컬 원장으로 멱등 보장, 어느 저장 모드에서도 동작 | `pnpm send:channels [--target telegram\|x\|both] [--ids]` | — |
| **K. 항목 계보(lineage) 조회** | 번역·변환·포맷 각 단계에서 저장할 때마다(다듬기·재승인 포함) 그 시점 결과물을 항목별로 append — 나중 저장이 이전 값을 덮어써도 사라지지 않고, 어느 시점에 무엇이 어떻게 바뀌었는지 확인 가능. 항상 켜져 있고 best-effort(계보 기록 실패가 저장을 막지 않음) | `pnpm lineage [itemId]` | — |
| **L. 설정 백업/공유** | git에 추적되지 않는 스티어링 설정(`translation/` + `conversion/`, `*.example.*` 제외 15개 파일)을 Google Drive에 타임스탬프 스냅샷(`steering-config-<시각>.json`)으로 백업하고, 팀원이 최신 스냅샷을 내려받아 복원 — 단일 관리자가 push(백업), 팀원은 pull(복원)만 하는 모델. `pull`은 덮어쓰기 전에 현재 로컬 설정을 `output/archive/`에 먼저 백업 | `pnpm config:push`, `pnpm config:pull [--dry-run]` | — |

> **드라이브 스코프 주의(L):** `config:push`/`config:pull`로 팀원과 공유하려면, pull하는 사람도
> **push한 사람과 같은 Google 자격증명**을 쓰거나(단일 유지보수자 모델), 그게 아니면 OAuth
> 스코프를 `drive.file`에서 `drive`로 넓혀야 합니다 — `drive.file`은 그 자격증명이 만든 파일만
> 보이기 때문입니다.

## 6. 번역 메모리

Mantle KR의 한국어 X 계정 `@0xMantleKR`은 `Mantle_Official`의 영어 게시물을 실제로 번역해 게시해
왔습니다 — 두 계정을 짝지으면 이미 사람이 승인한 EN→KO 번역 쌍을 얻을 수 있습니다. 이 쌍을
발굴해서 번역 few-shot에 추가하는 것이 번역 메모리(TM)입니다. 전체 흐름은 다음과 같습니다:

```
수집 → 측정 → 페어링 제안 → 사람 확인 → 승격 → 번역 프롬프트에 반영
```

- **수집** — `pnpm collect:reference`는 `@0xMantleKR`(환경변수 `REFERENCE_X_HANDLE`, 기본값
  `0xMantleKR`)을 격리된 저장소 `output/x/reference/`에 수집합니다. 이 계정은 번역 대상이
  아니라 페어링 재료이므로, `pnpm collect`가 채우는 번역 큐에는 섞이지 않습니다.
- **측정** — `pnpm tm:measure`는 전체 백필을 돌리기 전에 `@0xMantleKR`의 게시물 수와 예상
  수집 비용을 먼저 보고합니다.
- **페어링 제안** — `pnpm tm:pair`는 `Mantle_Official`(영어)과 `@0xMantleKR`(한국어) 게시물
  사이에서 캐시태그·해시태그·멘션 같은 공통 앵커가 일정 시간 창 안에서 겹치는 쌍을 EN↔KO 페어
  후보로 제안하고, 사람이 검토할 워크시트를 `output/x/reference/`에 씁니다.
- **사람 확인** — 제안된 각 페어는 사람이 직접 확인합니다. 거부하려면 워크시트 항목의
  `accept`를 `false`로 바꾸면 됩니다 — 제안된 상태만으로는 아직 아무것도 채택된 것이 아닙니다.
- **승격** — `pnpm tm:promote`는 사람이 승인한 페어만 `translation/tm.json`에 씁니다. 자동으로
  승격되는 페어는 없습니다.
- **번역 프롬프트에 반영** — `pnpm translate:prepare`는 기존의 큐레이션된 few-shot(변경 없음)에
  더해, 번역 배치와 같은 언어 앵커가 겹치는 TM 페어 중 가장 관련도 높은 것들을 함께 워크시트에
  넣습니다. 예전의 "최근 8개" 규칙은 이 방식으로 대체되었습니다.

> `translation/tm.json`은 다른 스티어링 설정과 마찬가지로 이 저장소에는 커밋되지 않고 로컬에만
> 남습니다 — 공개 저장소이기 때문입니다. 그리고 사람이 확인하지 않은 페어는 어떤 경로로도 TM에
> 들어가지 않습니다.

**정렬 패스(선택)** — `pnpm translate:align [--ids …] [--since …] [--limit …]`는 위 흐름과 별개로,
이미 `translate:save`로 저장했지만 아직 1차 검수를 통과하지 않은 초안을 대상으로 TM을 한 번 더
적용하는 선택적 단계입니다. "번역 프롬프트에 반영"이 배치 전체에 걸쳐 TM을 섞어 넣는 것과 달리,
정렬 패스는 초안 하나마다 그 영어 원문과 앵커가 겹치는 선례를 최대 3개만 골라 워크시트에 나란히
놓고, 로컬 에이전트가 (재번역이 아니라) 선례의 표현·용어에 맞춰 초안을 다듬게 합니다. 겹치는 앵커가
없는 초안은 워크시트에서 제외됩니다. 다듬은 결과는 그대로 `pnpm translate:save --id <id> --file
<korean.txt>`로 다시 저장하며(`--approve` 없이), 1차 검수는 이 단계를 건너뛰어도 그대로 필요합니다.

## 7. X 성과 지표

`pnpm metrics:record [--month YYYY-MM]`는 KR 공식 계정과 X로 활동하는 KOL들의 그 달 X 성과를
매달 워크북에 기록합니다. `--month`를 생략하면 실행 시점이 속한 달을 씁니다. 전체 흐름은 다음과
같습니다:

```
KOL list 읽기 → X 계정 조회 → 월간 집계 → x-performance 탭에 upsert
```

- **KOL list 읽기** — 사람이 관리하는 `KOL list` 탭을 헤더 이름으로 매핑해서 읽습니다. 플랫폼이
  X인 행만 골라내고, 섹션 구분용 행이나 빈 행, X가 아닌 행(예: 텔레그램)은 건너뜁니다.
- **X 계정 조회** — KR 공식 계정(`REFERENCE_X_HANDLE`, 기본값 `0xMantleKR`)과 앞서 골라낸 각 X
  KOL에 대해 팔로워 수와 그 달에 작성한 트윗을 twitterapi.io로 조회합니다.
- **월간 집계** — 조회한 트윗을 계정별로 모아 게시물 수(posts), 조회수 합(views), 참여
  (engagement = 좋아요+리트윗+답글+인용 합)를 계산하고, 팔로워 수는 조회 시점 스냅샷으로 씁니다.
- **`x-performance` 탭에 upsert** — 계정(account)·월(month) 조합을 키로 해당 행을 찾아 없으면
  추가하고 있으면 덮어씁니다. 이 탭은 이 명령이 전용으로 쓰는 기계 탭이며, `followers` /
  `posts` / `views` / `engagement`(+ 조회 시각) 같은 **원시 숫자만** 기록합니다 — 평균, 비율,
  Cost-per-Impression 같은 파생 값은 스프레드시트 수식이 담당하고 이 명령은 건드리지 않습니다.

**자동 vs 수동** — 자동으로 채워지는 것은 성과 숫자(팔로워/게시물/조회수/참여)뿐입니다. KOL
로스터 등록·계약 조건·정산 관련 컬럼은 여전히 사람이 `KOL list`/계약/월별 탭에서 직접 관리합니다.
텔레그램 KOL의 지표는 twitterapi.io가 X 전용이라 이 명령이 다루지 못하므로 계속 수동 입력입니다.

**기계는 사람 탭을 건드리지 않습니다** — 이 명령은 `x-performance` 탭에만 쓰고, 사람이 편집하는
`KOL list`/계약/월별 탭에는 절대 쓰지 않습니다(읽기 전용으로만 사용). 사람이 만든 파생 수식이나
서식이 실행할 때마다 덮어써질 걱정 없이 유지됩니다.

**사전 조건** — `cloud` 저장 모드, OAuth `spreadsheets` 스코프, `GSHEET_ID` 환경변수가 모두
필요합니다(`local` 모드에서는 `skipIfLocal`에 의해 아무 것도 하지 않고 건너뜁니다). 아직 실
워크북 기준으로 라이브 검증되지 않았습니다.

**과거 달 백필 주의** — 이번 달(`--month` 생략) 실행은 정확하지만, 과거 달을 지정해 백필할 때는
게시물이 많은 계정의 수치가 실제보다 적게 잡힐 수 있습니다(트윗 수집이 최신순으로 진행되며
`MAX_PAGES` 캡에 걸리면 목표 달에 도달하기 전에 멈추기 때문입니다).

## 8. 채널 발송

2차 검수에서 승인된 채널 렌더링(`telegram`/`x`)을 실제 채널로 보내는 단계입니다. 그동안은 승인
후에도 사람이 대시보드에서 텍스트를 복사해 직접 붙여넣어야 했지만, `pnpm send:channels`는
텔레그램과 X(Typefully 경유) 두 채널에 한해 그 붙여넣기를 실제 API 호출로 대신합니다. 전체
흐름은 다음과 같습니다:

```
승인된 렌더링 조회 → 채널별 sender 선택 → 발송 → 멱등 원장에 기록 → (cloud) history 탭에 best-effort 기록
```

- **대상** — `pnpm send:channels [--target telegram|x|both] [--ids <id1,id2,...>]`. `--target`을
  생략하거나 `both`를 주면 텔레그램·X 모두가 대상이고, `--ids`로 특정 항목만 좁힐 수 있습니다.
  `output/formatted/renderings.json`에서 `status: "approved"`이고 채널이 `telegram` 또는 `x`인
  행만 대상입니다 — `kakao`/`pr_mail`은 대상이 아닙니다(§4 참고).
- **텔레그램 = 봇 API.** Bot API `sendMessage`를 세그먼트(문단/트윗 경계)마다 한 번씩 HTML로
  호출하고, 두 번째 메시지부터는 첫 메시지에 답장(reply)으로 걸어 하나의 스레드처럼 이어 붙입니다.
- **X = Typefully 경유, 공식 API·twitterapi.io 쓰기는 쓰지 않습니다.** Typefully v2 draft API로
  세그먼트를 그대로 `posts` 배열에 담아 draft를 만들고 즉시 게시(`publish_at: "now"`)한 뒤,
  응답에 트윗 URL이 바로 오지 않으면 잠깐 폴링해서 받아옵니다. 공식 X API나 twitterapi.io로 직접
  쓰지 않는 이유는 공식 계정이 자동화 탐지로 정지(ban)될 위험을 피하기 위해서입니다 —
  twitterapi.io는 이 프로젝트 전체에서 읽기(수집·조회)로만 쓰이고, X에 무언가를 쓰는 경로는
  Typefully 하나뿐입니다.
- **멱등(idempotent) — 로컬 원장 `output/publish/channels.json`.** 발송에 성공한
  `(itemId, type, channel)` 조합은 원장에 한 행으로 남고, 다음 실행에서는 건너뜁니다(`skipped`).
  실패한 항목은 원장에 남지 않으므로 다음 실행에서 그대로 재시도됩니다 — 재실행은 항상 안전합니다.
- **어느 저장 모드에서도 동작합니다.** 이 명령은 `HERALD_STORAGE_MODE`를 아예 읽지 않습니다 —
  텔레그램 봇 토큰과 Typefully API 키만 있으면 `local`/`cloud` 구분 없이 그대로 발송됩니다
  ([`artifacts.md`](artifacts.md) §2).
- **Sheet `history` 탭 기록은 `cloud` 전용이고 best-effort입니다.** `GSHEET_ID`와 Google 인증이
  설정돼 있으면 발송 성공 시 `history` 탭에도 기록을 시도하지만, 이 기록이 실패해도 이미 보낸
  메시지를 취소하지는 않습니다 — 경고만 남기고 다음 항목을 계속 처리합니다. 설정이 없으면 이
  기록 자체를 조용히 건너뜁니다.
- **발송된 렌더링은 2차 완성본으로 best-effort 아카이브됩니다.** 실제로 나간 공지가
  `output/publish/local/sent/`(local) 또는 Drive `sent/` 폴더(cloud, `GDRIVE_SENT_FOLDER_ID`/
  `LARK_DRIVE_SENT_FOLDER_TOKEN` 설정 시)에 저장됩니다 — 미설정이어도 발송 자체는 그대로
  진행됩니다.
- **범위 밖.** 카카오·메일(`pr_mail`) 채널의 자동 전송, 이미지·미디어 첨부, 예약 발행, 대시보드의
  "발송" 버튼은 아직 없습니다 — 이 명령은 CLI 전용이며 텔레그램·X 텍스트만 다룹니다.

**사전 조건** — 텔레그램은 `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, X(Typefully)는
`TYPEFULLY_API_KEY`/`TYPEFULLY_SOCIAL_SET_ID` 환경변수가 필요합니다(`--target`으로 요청한 채널의
것만 있으면 됩니다). 값은 이 문서에 적지 않습니다 — `.env`에서 관리하세요.

## 9. 다음으로

- 처음 설치해서 로컬 모드로 써 보려면 → [`quickstart.md`](quickstart.md)
- 팀 내부 운영자로서 주간 루틴·클라우드 전환·장애 대응이 궁금하면 → [`team-runbook.md`](team-runbook.md)
- 어떤 명령이 정확히 무엇을 읽고 쓰는지 궁금하면 → [`artifacts.md`](artifacts.md)
- 번역·문구를 검수하고 승인만 하면 되면 (터미널 불필요) → [`review.md`](review.md)
