# 빠른 시작 (quickstart.md)

`mantle-kr-herald`를 처음 받아서 로컬에서 돌려 보려는 외부/오픈소스 독자를 위한 문서입니다.
프로젝트가 무엇을 하는지는 [`capabilities.md`](capabilities.md)를, 각 명령이 정확히 무엇을
읽고 쓰는지는 [`artifacts.md`](artifacts.md)를 참고하세요. Mantle KR 팀 내부 운영자라면 이
문서 대신 [`team-runbook.md`](team-runbook.md)를 보세요.

## 1. 준비물

**모든 자격 증명은 선택입니다.** `HERALD_STORAGE_MODE=local`이면 클라우드(Google/Lark
Drive·Sheet) 자격 증명 없이 파이프라인을 그대로 실행할 수 있습니다 — 번역(C)·변환(F)·채널
포맷(F)은 애초에 외부 API를 호출하지 않고, 로컬 Claude Code 에이전트가 워크시트를 채우는
방식으로 동작합니다([`capabilities.md`](capabilities.md) §4). 수집(A/B)만 사용하려는 소스의
키가 있어야 실제 새 콘텐츠를 가져옵니다 — X와 Lark를 둘 다 쓸 필요는 없습니다.

**필수**

- Node.js + pnpm
- 번역·변환·채널 포맷의 에이전트 단계를 위한 [Claude Code](https://claude.com/claude-code)

**선택 (쓰려는 소스/채널의 것만)**

| 자격 증명 | 필요한 곳 | 절차 |
|---|---|---|
| twitterapi.io API 키 | X 수집 (`pnpm collect`) | https://twitterapi.io 에서 발급받아 `.env`의 `TWITTERAPI_IO_KEY`에 설정 |
| Lark 앱 | Lark 수집 (`pnpm collect-lark`), Lark 메시지 전송 (`pnpm lark:send`) | [`lark-setup-guide.md`](../guides/lark-setup-guide.md) |
| Google OAuth | Drive 업로드, Google Sheet 데이터 허브 | [`google-drive-setup-guide.md`](../guides/google-drive-setup-guide.md), [`drive-setup-guide.md`](../guides/drive-setup-guide.md) |

## 2. 5분 시작

```bash
pnpm install
cp .env.example .env
pnpm config:init
pnpm doctor
pnpm status
```

- `pnpm install` — 의존성 설치.
- `cp .env.example .env` — 환경변수 스켈레톤 복사. 기본값 `HERALD_STORAGE_MODE=local`이라
  그대로 두면 클라우드 명령은 스킵되고 나머지는 전부 동작합니다.
- `pnpm config:init` — `translation/*.example.*`, `conversion/*.example.*`를 실제 파일
  (`translation/glossary.json` 등)로 복사합니다. 이미 있는 파일은 절대 덮어쓰지 않습니다.
- `pnpm doctor` — 저장 모드와 스티어링 설정 상태를 오프라인으로 점검합니다.
- `pnpm status` — 현재 파이프라인 진행 상황(수집→번역→변환→포맷→게시 깔때기)을 보여줍니다.
  아직 아무 것도 안 했으니 전부 0으로 나오는 게 정상입니다.

## 3. 첫 번역 배치

X 또는 Lark 자격 증명이 있어서 `pnpm collect` 또는 `pnpm collect-lark`로 몇 건 수집했다면
(§1 참고), 이제 첫 번역 배치를 진행합니다. 번역은 사람이 아니라 **로컬 Claude Code 에이전트**가
합니다.

```bash
pnpm translate:prepare --limit 3
```

`output/translations/worksheets/batch-<타임스탬프>.md` 워크시트와
`output/translations/pending.json`이 생깁니다(정확한 읽기/쓰기 목록은
[`artifacts.md`](artifacts.md) §3). 이 워크시트를 Claude Code에게 열어 각 항목의 **번역**
섹션을 채우도록 시키세요 — 원문 옆에 한국어 번역을 채워 넣는 작업입니다.

에이전트가 채운 한국어 텍스트를 파일로 저장한 뒤:

```bash
pnpm translate:save --id <itemId> --file <korean.txt> --approve
```

`--approve`를 붙이면 상태가 `approved`로 바뀌고 동시에 `translation/few-shot.json`에 예시로
승격됩니다 — 다음 배치의 번역 품질이 이 예시를 참고해 조금씩 좋아집니다.

## 4. 우리 팀에 맞추기

`pnpm config:init`이 만든 실제 스티어링 파일들은 전부 git에 추적되지 않습니다
([`artifacts.md`](artifacts.md) §1) — 자유롭게 고쳐서 우리 팀만의 것으로 만들면 됩니다.

- `translation/glossary.json` — 고유명사·용어 번역 규칙
- `translation/style-guide.md` — 번역 톤·문체 가이드
- `translation/locale.json` — 로케일 설정
- `conversion/{x,kol,pr}.md` — 채널별(타입별) 변환 스티어링

이 파일들은 로컬에만 존재하는 팀 자산입니다. 커밋되지 않으니 백업이 필요하면 직접 관리하세요.

## 5. local → cloud 승격

로컬에서 감이 잡혔고 결과물을 Google Drive/Lark Drive에 실제로 보관하고 싶다면:

1. [`google-drive-setup-guide.md`](../guides/google-drive-setup-guide.md)와
   [`lark-setup-guide.md`](../guides/lark-setup-guide.md)를 따라 Google/Lark 자격 증명을
   채웁니다.
2. `.env`에서 `HERALD_STORAGE_MODE=cloud`로 바꿉니다.
3. `pnpm doctor --live`로 실제 토큰 발급과 권한(스코프)까지 확인합니다.
4. `pnpm drive:publish`를 실행합니다.

`drive:publish`는 동기화 원장(`output/publish/state.json`)을 확인해 **아직 올라가지 않은
항목만** 업로드합니다. 지금까지는 원장이 비어 있으니(§2에서 `local` 모드로 지내는 동안 아무
것도 업로드된 적이 없으므로) `local` 모드에서 쌓인 번역 백로그 전체가 이 한 번의 실행으로
업로드됩니다. 이후에 다시 `drive:publish`를 돌리면 이미 올라간 항목은 자동으로 스킵됩니다
([`artifacts.md`](artifacts.md) §4 동기화 원장 참고).

## 6. 다음으로

- 명령이 정확히 무엇을 읽고 쓰는지 궁금하면 → [`artifacts.md`](artifacts.md)
- 이 프로젝트가 무엇을 하고 무엇을 하지 않는지 궁금하면 → [`capabilities.md`](capabilities.md)
- Mantle KR 팀 내부 운영자로서 주간 루틴·장애 대응이 궁금하면 → [`team-runbook.md`](team-runbook.md)
