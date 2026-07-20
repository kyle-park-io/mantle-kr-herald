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
- X — twitterapi.io를 통해 지정한 계정(기본 `Mantle_Official`)이 작성한 트윗을 스레드 단위로
  재구성해 수집 (`pnpm collect`)
- Lark 그룹 채팅 — 설정된 채팅방들의 텍스트/포스트 메시지를 채팅방별로 수집 (`pnpm collect-lark`)

**채널** (§6 채널 포맷 대상): `x` · `telegram` · `kakao` · `pr_mail`

**저장소**: `cloud` 모드에서는 Google Drive와 Lark Drive, `local` 모드에서는 로컬 폴더
`output/publish/local/`(업로드 대상 목록은 [`artifacts.md`](artifacts.md) 참고), 그리고 Google
Sheet(데이터 허브 — `targets`/`history` 탭)

## 4. 할 수 없는 것

이 프로젝트가 실제로 하지 않는 일은, 하는 일 만큼 분명하게 알아야 합니다.

- **어떤 채널로도 자동 게시하지 않습니다.** 발행은 `pnpm drive:publish`(또는 대시보드의 게시
  버튼)를 사람이 직접 실행할 때만 일어납니다 — 대상은 저장 모드에 따라 Google/Lark Drive
  (`cloud`) 또는 로컬 폴더 `output/publish/local/`(`local`)이며, 어느 쪽이든 X/텔레그램/카카오
  같은 실제 채널에 자동으로 올라가지는 않습니다. 번역이나 채널 렌더링을 승인(approve)하는 것
  자체는 업로드를 유발하지 않습니다 — 승인 경로(`SaveTranslation`, `ApproveRendering`)는 상태를
  `approved`로 바꿀 뿐 업로드 코드를 호출하지 않습니다. 저장 모드별 게이팅은
  [`artifacts.md`](artifacts.md)의 "저장 모드" 절을 참고하세요.
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
- **임프레션(§9b)은 구현되어 있지 않습니다.** `history` 탭 헤더에는 `impressions`/`impressionsAt`
  컬럼이 정의되어 있지만, `pnpm history:record`가 실제로 쓰는 것은 A~G 7개 컬럼뿐입니다 — 두
  컬럼은 항상 빈 채로 남습니다.

## 5. 모듈 지도

| 모듈 | 무엇을 하는가 | 주요 명령 | 관련 문서 |
|---|---|---|---|
| **A. X 데이터 수집** | twitterapi.io로 지정한 계정의 트윗을 스레드 단위로 재구성해 증분 수집하고, 삭제된 트윗을 소프트 마크로 반영 | `pnpm collect [handle]`, `pnpm reconcile` | — |
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
