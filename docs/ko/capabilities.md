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
Google Drive/Lark Drive 또는 로컬 폴더(`output/publish/local/`)에 올립니다. `cloud` 모드에서는
Google Sheet에 게시 이력도 남깁니다. 모든 단계는 개별 CLI 명령(`pnpm <script>`)으로 실행되며,
자동으로 다음 단계가 실행되지 않습니다 — 사람이 각 단계 사이를 직접 잇습니다.

## 2. 파이프라인

```
[수집]        pnpm collect, pnpm collect-lark
   │
   ▼
[번역]        pnpm translate:prepare → (로컬 에이전트가 워크시트 작성) → pnpm translate:save
   │
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

- **어떤 채널로도 자동 게시하지 않습니다.** 발행은 `pnpm drive:publish`(또는 대시보드의 게시
  버튼)를 사람이 직접 실행할 때만 일어납니다 — 대상은 저장 모드에 따라 Google/Lark Drive
  (`cloud`) 또는 로컬 폴더 `output/publish/local/`(`local`)이며, 어느 쪽이든 X/텔레그램/카카오
  같은 실제 채널에 자동으로 올라가지는 않습니다. 번역이나 채널 렌더링을 승인(approve)하는 것
  자체는 업로드를 유발하지 않습니다 — 승인 경로(`SaveTranslation`, `ApproveRendering`)는 상태를
  `approved`로 바꿀 뿐 업로드 코드를 호출하지 않습니다. 저장 모드별 게이팅은
  [`artifacts.md`](artifacts.md)의 "저장 모드" 절을 참고하세요.
- **텔레그램 봇·Typefully·X API를 통한 자동 전송도 아직 없습니다.** `telegram_bot`·`x_typefully`
  같은 목적지(destination)는 그 앱이 받아들이는 **텍스트를 만들어 줄 뿐**, 실제로 그 API를 호출해
  전송하는 코드는 없습니다 — 사람이 대시보드에서 복사해 직접 붙여넣거나 보냅니다. 다음 작업입니다.
- **스레드를 자동으로 나누지 않습니다.** X 목적지에서 세그먼트 하나가 가중치 한도(280, 순수 한글
  기준 140자)를 넘어도 경고(`overLimit`)만 남길 뿐 잘라내지 않습니다 — 실제로 나누는 것은
  `pnpm format --refine` 워크시트를 채우는 작성자입니다.
- **Typefully 붙여넣기 동작은 아직 실검증되지 않았습니다.** `x_typefully`는 현재 `x_paste`와 동일한
  텍스트를 냅니다. Typefully 에디터가 붙여넣은 텍스트에서 트윗 경계를 어떻게 처리하는지 1차 문서로
  확인된 바가 없어서입니다 — 실제 에디터에 canonical 초안을 붙여넣어 확인하기 전까지는 신뢰하지
  마세요.
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
| **C. 한국어 번역** | 수집된 X/Lark 콘텐츠로 번역 워크시트를 만들고, 로컬 에이전트가 채운 한국어 번역을 저장. 승인 시 few-shot 예시로 승격 | `pnpm translate:prepare`, `pnpm translate:save`, `pnpm glossary` | — |
| **D. Drive 업로드** | 승인/번역 완료된 결과를 마크다운으로 저장 — `cloud` 모드면 Google Drive와 Lark Drive에 업로드, `local` 모드면 `output/publish/local/{review,approved}/`에 파일로 저장 | `pnpm drive:publish`, `pnpm drive:init`, `pnpm google:auth` | [`setup/README.md`](setup/README.md), [`setup/google-drive.md`](setup/google-drive.md), [`setup/lark.md`](setup/lark.md) |
| **E. 검수 대시보드** | 번역(1차)·채널 포맷(2차)을 검수·수정·승인·발행하는 로컬 웹 대시보드 | `pnpm serve`, `pnpm build:web`, `pnpm dev:web` | — |
| **F. 콘텐츠 가공** | 승인된 번역을 §5 항목 변환(타입별 X/공지/KOL/PR)과 §6 채널 포맷(코드 변환 + 선택적 에이전트 다듬기) 두 단계로 채널용 게시물로 가공 | `pnpm convert:prepare`, `pnpm convert:save`, `pnpm format`, `pnpm format:save` | — |
| **G. Google Sheet 데이터 허브** | 팀이 함께 편집하는 배포 대상 목록(`targets` 탭)과 게시 이력(`history` 탭) 관리 | `pnpm sheet:init`, `pnpm targets:list`, `pnpm history:record` | [`external-integrations.md`](../architecture/external-integrations.md) |

## 6. 다음으로

- 처음 설치해서 로컬 모드로 써 보려면 → [`quickstart.md`](quickstart.md)
- 팀 내부 운영자로서 주간 루틴·클라우드 전환·장애 대응이 궁금하면 → [`team-runbook.md`](team-runbook.md)
- 어떤 명령이 정확히 무엇을 읽고 쓰는지 궁금하면 → [`artifacts.md`](artifacts.md)
- 번역·문구를 검수하고 승인만 하면 되면 (터미널 불필요) → [`review.md`](review.md)
