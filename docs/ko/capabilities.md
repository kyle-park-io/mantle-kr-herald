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
Google Sheet에 게시 이력도 남깁니다. 각 단계는 개별 CLI 명령(`pnpm <script>`)으로 실행되며,
자동으로 다음 단계가 실행되지 않습니다 — 사람이 각 단계 사이를 직접 잇습니다. **검수·승인·발송은
CLI 없이 Vercel에 배포된 대시보드에서도 할 수 있습니다** ([capabilities.md] §3 "실행 환경").

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

**예외 — [2차 검수]와 [채널 발송]은 화면 안에서 이어질 수 있습니다.** 2차 검수 화면은 `타입 · 채널`
카드마다 그 문구를 받는 방을 나열하고, 승인된 자동 방은 `발송`으로, 수동 방은 `복사`+`전달함`으로
그 자리에서 바로 처리할 수 있습니다 — 이 경우 그 방에 대해서는 [채널 발송] 단계가 이미 끝난
것입니다. `pnpm send:channels`는 여러 항목·여러 방을 한 번에 훑는 배치 실행으로 남아 있습니다
(예: 화면에서 미처 처리하지 않고 넘어간 나머지, 또는 자동화). 자세한 화면 사용법은
[`review.md`](review.md) §4를 보세요.

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

### 실행 환경 — 두 개의 엔트리포인트, 하나의 데이터베이스

**진실의 기록은 PostgreSQL 한 곳이고, 로컬 CLI와 호스팅 대시보드가 같은 데이터베이스를 봅니다.**
저장소 드라이버가 둘로 갈라진 게 아니라 **엔트리포인트가 둘**입니다 — 요청이 무엇을 뜻하는지
정하는 라우팅·유스케이스·세션 게이트·CSRF 방어는 양쪽이 같은 코드를 씁니다.

| | 로컬 (`pnpm serve`) | 호스팅 (Vercel) |
|---|---|---|
| 실행 | 운영자가 직접 띄우는 `node:http` 서버 | Vercel Function (`api/[...path].ts`, Node 런타임) |
| 접근 | `127.0.0.1`(로컬호스트) | `HERALD_DEPLOYMENT_ORIGIN`에 적은 배포 주소 |
| 검수·승인 | ○ | ○ |
| 발송 | ○ | `HERALD_SENDS_ENABLED=true`일 때만 |
| 에이전트 준비 단계 | ○ | ✕ (아래 §4) |

호스팅 배포에 필요한 것: `DATABASE_URL`, 대시보드 계정(`HERALD_AUTH_USERNAME` /
`HERALD_AUTH_PASSWORD_HASH`), `HERALD_SESSION_SECRET`, `HERALD_DEPLOYMENT_ORIGIN`, 그리고
**`HERALD_TRUST_PROXY=true`**. 마지막 항목은 선택이 아니라 기동 조건입니다 — Vercel 엣지 네트워크가
클라이언트 연결을 대신 끊기 때문에, 이 설정이 없으면 모든 요청이 "믿을 만한 주소 없음"으로 풀려
주소별 로그인 잠금이 셀 키를 못 얻습니다. 그래서 함수가 아예 뜨지 않습니다. 값은 `.env.example`의
호스팅 배포 절을 참고하세요.

> **왜 Drive가 아니라 Postgres인가.** `HERALD_STORAGE_MODE=cloud`가 이미 있으니 Drive가 자연스러운
> 후보처럼 보이지만, Drive는 내구성은 주고 **원자성과 잠금은 주지 않습니다.** 저장소들은 파일
> 전체를 읽고-고쳐-쓰는 방식이고, 두 발송 원장은 인프로세스 큐(`serialWrites.ts`)와 프로세스 간
> 파일 락(`fileLock.ts`) 두 겹에 안전성을 기대고 있는데 **서버리스에서는 두 겹 모두 증발합니다.**
> 원장에서 행 하나가 빠지면 이미 나간 공지를 다음 실행이 한 번 더 발송합니다. Postgres는 유니크
> 인덱스로 이 문제를 닫을 수 있고 Drive는 닫을 수 없습니다.

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
- **대시보드 계정은 하나뿐이고, 누가 승인했는지 남지 않습니다.** 호스팅 배포는 팀이 공유하는 단일
  자격증명 하나로 들어갑니다(`HERALD_AUTH_USERNAME` / `HERALD_AUTH_PASSWORD_HASH`). 사용자별 계정도,
  사용자별 감사 추적도 없습니다 — 트레이드오프를 알고 받아들인 결정입니다. 승인·발송 기록은 남지만
  **그 행동을 한 사람이 누구인지는 기록되지 않습니다.**
- **에이전트에게 넘기는 준비 단계는 로컬 CLI 전용입니다.** `translate:prepare` / `convert:prepare`가
  만드는 워크시트는 로컬 에이전트가 채워야 하므로, 호스팅 엔트리포인트는 이 라우트를 아예 등록하지
  않습니다(대시보드의 `[변환 준비]`가 그것입니다). 호스팅 쪽에서 요청을 큐에 쌓아 두는 방식은
  보류했습니다.
- **발송 상태 대조(reconcile)는 로컬에 남습니다.** `pnpm send:reconcile`은 운영자 쪽 크론으로 2분
  주기로 돌아갑니다 — Vercel Hobby 플랜의 크론 상한이 하루 한 번이라 호스팅으로 옮길 수 없습니다.
- **호스팅 대시보드의 발송은 기본적으로 닫혀 있습니다.** `HERALD_SENDS_ENABLED=true`를 명시해야
  열립니다. 닫힌 상태에서는 화면의 `발송`/`재발송` 버튼도 함께 잠기므로, 눌러 놓고 나간 줄 아는
  일이 생기지 않습니다.
- **Lark는 아직 채널 포맷 대상이 아닙니다.** §6 채널 포맷은 `x` · `telegram` · `kakao` ·
  `pr_mail` 네 개만 지원합니다(`Channel` 타입). `pnpm lark:send`가 존재하지만, 이는 `--text`
  인자를 그대로 전송하는 독립적인 메시지 전송 명령일 뿐 파이프라인 콘텐츠(번역/변환/포맷 결과)와
  연결되어 있지 않습니다.
- **임프레션(§9b ③)은 X만 지원합니다.** `pnpm impressions:record`가 `history` 탭의 `channel=x`
  행을 트윗 조회해 `impressions`(viewCount)/`impressionsAt` 두 컬럼(H·I)을 채웁니다 —
  발송 기록은 A~G(그리고 방 id는 J)만 쓰고 이 두 컬럼은 §9b 몫으로 비워두기 때문입니다. 텔레그램/카카오
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
| **J. 채널 발송** | 승인된 채널 렌더링(텔레그램·X)을 실제 API로 발송 — 텔레그램은 봇 API, X는 Typefully 경유(공식 API·twitterapi.io 쓰기 없음). 로컬 원장으로 멱등 보장(단, `dropped`로 물러난 행은 예외 — 그 방을 다시 발송 대상으로 만듦, §8 참고), 어느 저장 모드에서도 동작 | `pnpm send:channels [--target telegram\|x\|both] [--ids] [--pin]` | — |
| **K. 항목 계보(lineage) 조회** | 번역·변환·포맷 각 단계에서 저장할 때마다(다듬기·재승인 포함) 그 시점 결과물을 항목별로 append — 나중 저장이 이전 값을 덮어써도 사라지지 않고, 어느 시점에 무엇이 어떻게 바뀌었는지 확인 가능. **방별로 갈라 쓴 글(`forked`, 구분자 `타입/방id`)도 저장·승인 시점은 물론 `그룹 글로 되돌리기`로 버리는 시점까지 남습니다** — 그 본문은 `overrides.json`에만 있고 다시 만들어낼 수 없기 때문입니다(되살리기는 자동이 아니라 사람이 복사해 붙여넣는 것). 항상 켜져 있고 best-effort(계보 기록 실패가 저장을 막지 않음) — **단 되돌리기만은 예외로, 버릴 본문을 기록하지 못하면 되돌리기가 실패하고 포크는 지워지지 않습니다** | `pnpm lineage [itemId]` | — |
| **L. 설정 백업/공유** | git에 추적되지 않는 스티어링 설정(`translation/` + `conversion/`, `*.example.*` 제외 15개 파일)을 Google Drive에 타임스탬프 스냅샷(`steering-config-<시각>.json`)으로 백업하고, 팀원이 최신 스냅샷을 내려받아 복원 — 단일 관리자가 push(백업), 팀원은 pull(복원)만 하는 모델. `pull`은 덮어쓰기 전에 현재 로컬 설정을 `output/archive/`에 먼저 백업 | `pnpm config:push`, `pnpm config:pull [--dry-run]` | — |
| **M. 운영 상태 백업/복구** | 데이터베이스에서 **다시 만들 수 없는** 일곱 개 — 사람이 검수한 글(`translations/translations.json`, `variants/variants.json` — 다시 돌리면 *어떤* 결과는 나오지만 그 결과는 아니고 검수를 다시 해야 합니다), 채널별 최종 렌더링과 그 **2차 검수 승인 상태**(`formatted/renderings.json` — 렌더링 텍스트 자체는 `format`이 변환본에서 다시 만들지만, 사람이 승인했다는 사실이나 손으로 다듬은 내용은 재생성되지 않습니다), 방별 포크(`formatted/overrides.json`), 발송 원장(`publish/deliveries.json`, `publish/x-article.json` — 예전 형식 `publish/channels.json`은 `pnpm db:import`가 그 행을 이미 `deliveries.json` 쪽으로 옮겨 놓았으므로 더는 따로 스냅샷하지 않습니다), 동기화 원장(`publish/state.json`) — 을 Google Drive에 타임스탬프 스냅샷(`operational-state-<시각>.json`)으로 백업하고 되살림. L과 달리 **공유가 아니라 이 기기 한 대의 복구**이므로, `pull`은 `--yes` 없이는 미리보기만 하고 파일마다 **현재 행 수와 스냅샷 행 수를 나란히** 보여주며, 쓰기 전에 데이터베이스의 현재 내용을 `output/archive/state-<시각>/`에 백업하고, 파싱·백업이 실패하면 아무것도 쓰지 않고 중단. 스냅샷의 각 행을 데이터베이스에 **가져올(upsert)** 뿐 대체하지 않으므로, 스냅샷에 없는 기존 행은 지워지지 않고 그대로 남음 | `pnpm state:push`, `pnpm state:pull [--yes]` | — |
| **N. 텔레그램 KOL 딜리버러블 동기화** | 사람이 관리하는 `kol-map` 탭(활성 채널만)을 읽어 각 텔레그램 KOL의 공개 채널을 그 달 구간으로 훑고, 맨틀 언급 후보 게시물을 찾아 승인된 텔레그램 렌더링과 매칭(제안)한 뒤 기계 전용 `kol-telegram-posts` 탭에 게시물 단위로 upsert | `pnpm kol-telegram:record [--month YYYY-MM]` | — |
| **O. X 발행 재확인** | `@0xMantleKR`에 실제로 올라간 글을 읽어 우리 기록과 맞춥니다. 승인된 `x` 렌더링과 문자 단위로 대조해 그대로 올라간 것은 발송됨으로 표시하고, 아직 렌더링이 없는 번역(1차 검수 대기든 승인됨이든)은 더 낮은 문턱으로 따로 대조해 손으로 먼저 게시된 것이 확인되면 그 번역 자체를 **게시됨**으로 못박습니다 — 렌더링·변환·발송 단계를 하나도 거치지 않고 끝나는 항목이 생긴다는 뜻입니다. 이렇게 게시됨으로 못박힌 항목은 실제로 올라간 한국어 원문도 함께 채웁니다 — 이미 채워진 값은 절대 덮어쓰지 않고, 그 실행의 `--since` 창에 아직 걸리는 게시물만 대상입니다(아래 §6 참고). 파이프라인 밖에서 쓴 글은 게시 이력에만 남김. 읽기·기록 전용이고 X에는 아무것도 쓰지 않으며, `--yes` 없이는 미리보기만 함 | `pnpm x:reconcile [--since] [--handle] [--yes]` | [`team-runbook.md`](team-runbook.md) §6 |

> **L과 M을 섞지 마세요:** L(스티어링 설정)은 관리자가 push하고 팀원이 pull하는 **공유**지만,
> M(운영 상태)은 **이 기기가 무엇을 이미 보냈는가의 기록**입니다. 남의 운영 상태를 pull하면 자기
> 발송 원장이 남의 것으로 덮이고, 이미 글을 보낸 방이 미발송으로 보입니다 — 확인 창 한 번이면 몇 달
> 전 글이 살아 있는 커뮤니티 방으로 나갑니다. 폴더도 `steering-config`와 `operational-state`로
> 따로 둡니다.

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

**발행본 대조(선택)** — `pnpm translate:check [--status] [--since] [--published]`은 초안이
용어집(`translation/glossary.json`)의 결정을 지켰는지 보는 별도 점검입니다. 기본은 우리
초안을 검사하고, `--published`를 주면 대신 위 O(X 발행 재확인)가 게시됨 항목에
채워 둔 실제 발행 원문을 검사합니다 — 아직 원문이 없는 항목은 건너뛰고, 몇 건을 건너뛰었는지
함께 보고합니다. 옵션과 무관하게 이 명령은 **오버라이드(override)** 도 항상 함께 보고합니다:
우리 초안은 용어집 그대로 정확히 썼는데 실제로 올라간 글에서는 사람이 그 표현을 다른 말로 바꿔
놓은 용어 목록입니다. **이건 그 번역이 틀렸다는 뜻이 아니라, 그 용어집 항목 자체가 팀이 실제로
쓰는 말과 어긋나 있다는 신호입니다** — 용어집을 고칠지 검토할 후보로 읽으세요. 읽기 전용이고,
드리프트가 나와도 종료 코드를 실패로 바꾸지 않습니다. TM의 few-shot 승격과는 별개입니다 — 이
대조로 자동 승격되는 예시는 없고, few-shot에 반영하려면 여전히 위 `tm:promote`(사람이 확인한
페어만)를 거쳐야 합니다.

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
`DEFAULT_MAX_PAGES` 캡에 걸리면 목표 달에 도달하기 전에 멈추기 때문입니다).

## 8. 채널 발송

2차 검수에서 승인된 채널 렌더링(`telegram`/`x`)을 실제 채널로 보내는 단계입니다. 그동안은 승인
후에도 사람이 대시보드에서 텍스트를 복사해 직접 붙여넣어야 했지만, `pnpm send:channels`는
텔레그램과 X(Typefully 경유) 두 채널에 한해 그 붙여넣기를 실제 API 호출로 대신합니다. 전체
흐름은 다음과 같습니다:

```
승인된 렌더링 조회 → 채널별 sender 선택 → 발송 → 멱등 원장(`dropped` 행은 예외)에 기록 → (cloud) history 탭에 best-effort 기록
```

- **대상** — `pnpm send:channels [--target telegram|x|both] [--ids <id1,id2,...>] [--pin]`. `--target`을
  생략하거나 `both`를 주면 텔레그램·X 모두가 대상이고, `--ids`로 특정 항목만 좁힐 수 있습니다.
  `output/formatted/renderings.json`에서 `status: "approved"`이고 채널이 `telegram` 또는 `x`인
  행만 대상입니다 — `kakao`/`pr_mail`은 대상이 아닙니다(§4 참고). `--pin`은 이번 실행이 보낸
  텔레그램 메시지를 그 방에 고정하는 옵션 플래그로, 기본은 꺼짐입니다.
- **텔레그램 = 봇 API.** Bot API `sendMessage`를 세그먼트(문단/트윗 경계)마다 한 번씩 HTML로
  호출하고, 두 번째 메시지부터는 첫 메시지에 답장(reply)으로 걸어 하나의 스레드처럼 이어 붙입니다.
- **X = Typefully 경유, 공식 API·twitterapi.io 쓰기는 쓰지 않습니다.** Typefully v2 draft API로
  세그먼트를 그대로 `posts` 배열에 담아 draft를 만들고 즉시 게시(`publish_at: "now"`)한 뒤,
  응답에 트윗 URL이 바로 오지 않으면 잠깐 폴링해서 받아옵니다. 공식 X API나 twitterapi.io로 직접
  쓰지 않는 이유는 공식 계정이 자동화 탐지로 정지(ban)될 위험을 피하기 위해서입니다 —
  twitterapi.io는 이 프로젝트 전체에서 읽기(수집·조회)로만 쓰이고, X에 무언가를 쓰는 경로는
  Typefully 하나뿐입니다.
- **멱등(idempotent) — 로컬 원장 `output/publish/deliveries.json`.** 발송에 성공한
  `(itemId, type, outletId)` 조합은 원장에 한 행으로 남고, 다음 실행에서는 건너뜁니다(`skipped`).
  **채널이 아니라 방 단위**라 한 채널에 방이 둘이면 각각 한 행이 남습니다. 실패한 항목은 원장에 남지
  않으므로 다음 실행에서 그대로 재시도됩니다. 예전 `channels.json`은 읽기
  전용으로 이관됩니다(채널 → 그 채널의 대표 방).
  - **한 가지 예외 — `status: "dropped"`(화면의 `예약 취소됨`) 행은 걸러내지 않습니다.** X 발송은
    Typefully 큐에 예약으로 들어가고, 그 초안이 게시 전에 지워지면 그 방에는 아무것도 도착하지
    않습니다. `pnpm send:reconcile`(또는 대시보드 배경 확인)이 그 사실을 확인하면 행의 상태를
    `dropped`로 바꾸는데, **그 순간부터 그 조합은 다시 발송 대상**이 됩니다 — 의도한 동작입니다
    (아무것도 받지 못한 방을 영영 막아 두지 않기 위해서). 따라서 정확한 표현은 "재실행은 항상 아무
    일도 하지 않는다"가 아니라 "**실제로 도착한 것은 두 번 나가지 않는다**"입니다. 판정은
    `deliveredToRoom`(`src/domain/delivery/models.ts`) 하나가 모든 곳에서 담당합니다.
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
- **범위 밖.** 카카오·메일(`pr_mail`) 채널의 자동 전송, 이미지·미디어 첨부, 예약 발행은 아직
  없습니다 — 이 명령이 다루는 것은 텔레그램·X 텍스트뿐입니다. **다만 "CLI 전용"은 더 이상 아닙니다:**
  2차 검수 화면에서 방마다 바로 발송할 수 있고([capabilities.md] §2의 예외), 그 화면은 로컬과
  호스팅 양쪽에서 뜹니다. `pnpm send:channels`는 여러 항목·여러 방을 한 번에 훑는 배치 실행으로
  남아 있습니다.

**사전 조건** — 텔레그램은 `TELEGRAM_BOT_TOKEN` + 방별 `TELEGRAM_CHAT_ID_COMMUNITY`/
`TELEGRAM_CHAT_ID_DEV`(레거시 `TELEGRAM_CHAT_ID`는 커뮤니티방 폴백), X(Typefully)는
`TYPEFULLY_API_KEY`/`TYPEFULLY_SOCIAL_SET_ID` 환경변수가 필요합니다(`--target`으로 요청한 채널의
것만 있으면 됩니다). 값은 이 문서에 적지 않습니다 — `.env`에서 관리하세요.

## 9. 텔레그램 KOL 딜리버러블 동기화

`pnpm kol-telegram:record [--month YYYY-MM]`는 계약된 텔레그램 KOL들의 공개 채널을 훑어 맨틀을
언급한 게시물을 찾아 매달 워크북의 검수 탭에 기록합니다. `--month`를 생략하면 실행 시점이 속한
달을 씁니다. 전체 흐름은 다음과 같습니다:

```
kol-map 읽기 → 채널별 텔레그램 프리뷰 스윕 → 맨틀 후보 판별 → 승인된 렌더링과 매칭(제안) → kol-telegram-posts 탭에 upsert
```

- **`kol-map` 읽기** — 사람이 관리하는 `kol-map` 탭에서 `active`가 참인 행만 골라 KOL id·텔레그램
  핸들·건당 단가를 읽습니다. 최초 한 번 `Q3 조정 단가 표`의 13개 채널 핸들로 채워 두면 그 뒤로는
  계속 재사용됩니다(셋업 절차는 [`team-runbook.md`](team-runbook.md), 붙여넣을 표는
  [`kol-map-seed.md`](kol-map-seed.md) 참고).
  `tgHandle` 칸은 `https://t.me/<핸들>`·`t.me/<핸들>`·`@<핸들>`·`<핸들>` 네 형태를 모두 받습니다.
  대소문자는 신경 쓰지 않아도 됩니다 — t.me가 대소문자를 구분하지 않고 찾아 주고, 기록되는
  permalink는 항상 채널의 정식 표기를 씁니다. 어느 형태로도 읽을 수 없는 칸은 **그 행이 몇 번째
  행인지 이름과 함께 경고로 남고** 그 채널만 스윕에서 빠집니다 — 조용히 사라지지 않습니다.
  단가 칸은 `$100.00`·`₩100`·`US$1,100`처럼 통화 서식이 붙어 있어도 읽습니다. 숫자로 읽을 수 없는
  단가는 경고를 남기고 그 채널의 행은 단가를 **빈칸으로** 기록합니다 — 나중에 `kol-map`을 고쳐서
  다시 돌리면 아직 빈칸인 행에 채워지므로 고칠 기회가 남습니다.
- **채널별 스윕** — 각 활성 채널의 공개 프리뷰 페이지(`https://t.me/s/<handle>`, 공식 API가 아님)를
  `--month` 구간에 걸릴 때까지 페이지를 넘겨가며 읽습니다. 별도 API 키가 필요 없습니다.
- **맨틀 후보 판별** — 게시물 본문에 `맨틀`·`mantle`·`MNT`(단어 경계 매칭)가 있으면 후보입니다.
  일부러 넓게 잡습니다 — 결과는 검수 탭 한 줄로 남을 뿐이라 오탐의 비용은 사람이 한 번 걸러내는
  키 입력이지만, 놓치면 정산 근거 자체가 사라지기 때문입니다.
- **매칭(제안)** — 후보 게시물의 본문을 승인된 텔레그램 채널 렌더링(`status: "approved"`이고
  `channel: "telegram"`인 것만)과 문자 3-그램 자카드 유사도로 비교해, 점수가 0.30 이상인 가장
  가까운 것의 `itemId`를 제안합니다. 어디까지나 제안이며, 사람이 검수 탭에서 그대로 확정하거나
  고칠 수 있습니다.
- **`kol-telegram-posts` 탭에 upsert** — 텔레그램 permalink(`deliverableLink`)를 키로 기존 행을
  찾아 없으면 새 행을 추가합니다. 있으면 `views`/`engagements`/`reactionsDetail`/`fetchedAt` 네
  측정값을 갱신하고(단 `confirmed`가 `reject`인 행은 손대지 않으므로 **그 행의 측정값도 그 상태로
  멈춥니다**), `itemId`/`matchScore`/`topic`/`pricePerPost`는 **그 칸이 아직 비어 있을 때만** 채웁니다
  — 한 번 채워지면(기계가 채웠든 사람이 고쳤든) 다음 실행이 절대 덮어쓰지 않습니다. 이 블랭크 전용
  채움 규칙이 아래 "7월 백필 주의"의 재실행 시나리오를 성립시킵니다.
- **기계는 자기가 바꾼 칸만 씁니다.** 기존 행을 갱신할 때 실제로 값이 달라진 칸만 골라
  씁니다 — 측정값만 바뀐 보통의 경우에는 `E:G`와 `L`만 쓰고, `pricePerPost`(K)와 `confirmed`(M)는
  기계가 쓰는 범위 **안에 아예 들어가지 않습니다**. 값을 그대로 복사해 덮어쓰는 방식이 아니라
  범위 자체를 좁히는 방식이라, 실행 도중(한 번 돌리는 데 몇 분 걸립니다) 사람이 같은 행을 고치고
  있어도 그 편집이 사라지지 않습니다. 바뀐 칸이 하나도 없으면 아무것도 쓰지 않습니다.

**이 명령이 쓰는 탭은 `kol-telegram-posts` 하나뿐입니다.** `kol-map`, `KOL list`, 계약 리스트,
`Jul.`/`Aug.`/`Sep.` 월별 탭에는 절대 쓰지 않습니다. **`confirmed`(빈 값/`paid`/`organic`/`reject`)는
사람이 직접 채우는 유일한 컬럼**이며, 이 명령은 그 값을 절대 덮어쓰지 않습니다 — `paid`/`organic`으로
확정한 행을 월별 탭(`Jul.`/`Aug.`/`Sep.`)으로 옮기는 것도 사람의 몫입니다(자동 이관 없음).

**채널 격리** — 채널 하나가 비공개로 바뀌었거나 삭제·개명됐으면 그 채널만 건너뛰고 경고를 남긴 뒤
나머지를 계속 처리합니다(`metrics:record`와 같은 방식). 실행 요약은 스윕한 채널 수·실패한 채널
수·**절단된(truncated) 채널 수**를 항상 함께 보고하고, 실패나 절단이 하나라도 있으면 그 사실을
명시적으로 알립니다 — 그래야 조용한 `0 created`가 "이번 달은 게시물이 없었다"로 오인되지 않습니다.
**"읽을 수 없는 채널"의 판정 기준은 HTTP 오류가 아니라 "그 페이지에 게시물 블록이 아예 하나도
없었다"입니다.** 삭제·개명된 핸들이나 프리뷰를 끈 채널은 오류를 내지 않습니다 —
`https://t.me/s/<핸들>`이 `https://t.me/<핸들>`로 302 리다이렉트되고, 그 안내 페이지는 멀쩡한
HTTP 200이라서 아무것도 던지지 않은 채 게시물 0건으로 보입니다. 그래서 첫 페이지에 블록이 하나도
없으면 실패로 세고 채널 이름과 함께 경고합니다. 반대로 블록은 있는데 그 달 구간에 걸리는 게 없는
경우는 **정상**입니다 — 그 채널이 그 달에 실제로 안 올린 것이므로 실패로 세지 않습니다.
**어떤 채널도 스윕하지 못한 실행(`0 channel(s) swept`)은 따로 크게 경고합니다** — `kol-map`에
`active`가 참이고 핸들이 읽히는 행이 하나도 없다는 뜻이며, 조용한 성공처럼 보이는 화면이 실제로는
아무것도 읽지 않은 상태이기 때문입니다.
여기서 "절단"이란 한 채널의 스윕이 그 달을 다 훑기 전에 페이지 상한(`maxPages`)에 걸려 멈춘 경우를
말합니다 — 오류는 아니라서 실패로 세지 않지만(수집한 행은 그대로 남습니다), 그 채널의 그 달 집계가
불완전할 수 있다는 뜻이므로 실패와 별개의 카운터로 보고합니다.

**사전 조건** — `cloud` 저장 모드와 `GSHEET_ID` 환경변수가 필요합니다(`local` 모드에서는
`skipIfLocal`에 의해 아무 것도 하지 않고 건너뜁니다). 텔레그램 프리뷰 페이지는 공개 웹페이지라
별도의 API 키나 봇 토큰이 필요 없습니다.

**7월 백필 주의** — 승인된 렌더링은 2026-07-21부터 존재합니다. 그보다 이른 게시물은 처음 기록될
때 매칭 후보가 없어 `itemId`/`matchScore`/`topic`이 빈 채로 남습니다 — 버그가 아니라 예상된
동작입니다. 그때까지는 사람이 topic을 직접 채워도 되고, 그렇게 채운 값은 나중에도 지워지지
않습니다. 그리고 나중에 승인된 문구가 쌓인 뒤 **같은 `--month 2026-07`로 다시 실행하면**, 바로 위
블랭크 전용 채움 규칙 덕분에 아직 비어 있던 행들에 소급 귀속될 수 있습니다 — 7월 재실행은 그래서
의미가 있습니다.

**단, 지난 달을 다시 돌릴 때는 요약의 `channel(s) truncated`를 꼭 확인하세요.** 프리뷰 페이지는
최신 글부터 거꾸로만 넘길 수 있어서, 지난 달에 닿으려면 그 사이의 모든 글을 먼저 지나가야 합니다.
게시량이 많은 채널(실측: 한 채널이 한 달에 236건)은 페이지 상한(50페이지)에 먼저 걸릴 수 있고,
그러면 그 채널은 **그 달에 닿지 못한 채 끝나 소급 귀속이 일어나지 않습니다.** 그 경우 그 채널이
`truncated`로 세어져 경고가 남으므로, `0 refreshed`인데 `truncated`가 0이 아니면 소급이 안 된
것으로 보고 그 채널은 사람이 확인해야 합니다. CLI도 지난 달을 대상으로 돌리면 실행 전에 이 점을
미리 경고합니다.

**월 경계는 UTC 기준입니다.** KST가 아니라 UTC로 그 달의 시작·끝을 자릅니다(X 쪽
`metrics:record`와 같은 방식이라 일부러 맞춰 둔 것입니다). 그래서 예를 들어 2026-08-01 05:00
KST에 올라온 게시물은 UTC로는 7월 31일이라 **7월분으로 집계됩니다.** 월말·월초에 걸친 게시물
하나 때문에 그 KOL의 그 달 딜리버러블 건수가 하나 어긋날 수 있으니, 계약 건수를 맞출 때는 경계에
있는 게시물의 `postedAt`을 직접 보세요.

## 10. 다음으로

- 처음 설치해서 로컬 모드로 써 보려면 → [`quickstart.md`](quickstart.md)
- 팀 내부 운영자로서 주간 루틴·클라우드 전환·장애 대응이 궁금하면 → [`team-runbook.md`](team-runbook.md)
- 어떤 명령이 정확히 무엇을 읽고 쓰는지 궁금하면 → [`artifacts.md`](artifacts.md)
- 번역·문구를 검수하고 승인만 하면 되면 (터미널 불필요) → [`review.md`](review.md)
