# 빠른 시작 (quickstart.md)

`mantle-kr-herald`를 처음 받아서 로컬에서 돌려 보려는 외부/오픈소스 독자를 위한 문서입니다.
프로젝트가 무엇을 하는지는 [`capabilities.md`](capabilities.md)를, 각 명령이 정확히 무엇을
읽고 쓰는지는 [`artifacts.md`](artifacts.md)를 참고하세요. Mantle KR 팀 내부 운영자라면 이
문서 대신 [`team-runbook.md`](team-runbook.md)를 보세요.

## 1. 준비물

**모든 자격 증명은 선택입니다.** `HERALD_STORAGE_MODE=local`이면 클라우드(Google/Lark
Drive·Sheet) 자격 증명 없이 파이프라인을 그대로 실행할 수 있습니다 — 번역(C)·변환(F)·채널
포맷(F)은 애초에 외부 API를 호출하지 않고, 로컬 Claude Code 에이전트가 워크시트를 채우는
방식으로 동작합니다([`capabilities.md`](capabilities.md) §4). 발행(`pnpm drive:publish`)도
`local`에서 그대로 동작합니다 — Drive에 올리는 대신 `output/publish/local/`에 결과물을
저장합니다. 수집(A/B)만 사용하려는 소스의 키가 있어야 실제 새 콘텐츠를 가져옵니다 — X와 Lark를
둘 다 쓸 필요는 없습니다.

**필수**

- Node.js + pnpm
- **Postgres** — 자격 증명이 아니라 파이프라인의 기록 원본입니다. 아래 §1.5 참고
- 번역·변환·채널 포맷의 에이전트 단계를 위한 [Claude Code](https://claude.com/claude-code)

> **"모든 자격 증명은 선택"에 Postgres는 포함되지 않습니다.** `HERALD_STORAGE_MODE=local`의
> "local"은 **발행 산출물이 어디로 가느냐**(`output/` vs Drive)이지, 데이터베이스를 안 쓴다는
> 뜻이 아닙니다. 번역·변환·렌더링·발송 이력 같은 **원장**은 Postgres에 있고, 로컬 모드에서도
> 그렇습니다. 24개 명령이 데이터베이스를 엽니다 — `DATABASE_URL` 없이 도는 건
> `config:init`·`glossary`·`archive`·`clean`·`tm:promote`·`auth:hash` 여섯 개뿐입니다.

**선택 (쓰려는 소스/채널의 것만)**

| 자격 증명 | 필요한 곳 | 절차 |
|---|---|---|
| twitterapi.io API 키 | X 수집 (`pnpm collect`) | https://twitterapi.io 에서 발급받아 `.env`의 `TWITTERAPI_IO_KEY`에 설정 |
| Lark 앱 | Lark 수집 (`pnpm collect-lark`), Lark 메시지 전송 (`pnpm lark:send`) | [`setup/lark.md`](setup/lark.md) |
| Google OAuth | Drive 업로드, Google Sheet 데이터 허브 | [`setup/google-drive.md`](setup/google-drive.md), [`setup/README.md`](setup/README.md) |

## 1.5. Postgres 하나 띄우기

이미 쓰는 Postgres가 있으면 그걸 써도 됩니다. 없으면 도커 한 줄이 제일 빠릅니다:

```bash
docker run -d --name herald-db \
  -e POSTGRES_PASSWORD=herald -e POSTGRES_DB=herald \
  -p 5432:5432 postgres:16-alpine
```

그리고 `.env`에 두 줄:

```
DATABASE_URL=postgres://postgres:herald@127.0.0.1:5432/herald
HERALD_DB_ENV=development
```

**테이블은 직접 만들지 않습니다.** 빈 데이터베이스에 한 번만:

```bash
pnpm db:import --yes
```

`--yes` 없이 돌리면 무엇이 들어갈지 미리 보여주고 아무것도 쓰지 않습니다. 새로 클론했다면
`output/`이 비어 있으니 이 명령은 **스키마만 만들고 끝납니다** — 가져올 게 없으니까요.
멱등이라 여러 번 돌려도 됩니다.

> 이 단계를 건너뛰면 `pnpm doctor`가
> `✗ Database — Schema not applied — relation "deliveries" does not exist`로 알려주고,
> 고치는 명령까지 같이 출력합니다. `pnpm status`는 그냥 실패합니다.

`HERALD_DB_ENV`는 추론되지 않습니다 — 접속 문자열만 봐서는 내 노트북 DB인지 팀 공용 DB인지
구분할 수 없어서, 어느 쪽인지 **직접 말해야** 합니다. 로컬이면 `development`이고, 그러면
대시보드 상단에 `개발 데이터베이스` 배너가 뜹니다.

## 2. 5분 시작

```bash
pnpm install
cp .env.example .env
chmod 600 .env          # 자격 증명이 들어갈 파일인데, 복사 원본이 git 추적 파일이라 644로 생깁니다
# .env를 열어 §1.5의 DATABASE_URL / HERALD_DB_ENV 두 줄을 채웁니다
pnpm db:import --yes    # 스키마 생성 (빈 DB에 한 번)
pnpm config:init
pnpm doctor             # 전부 ✓/⚠ 여야 하고, ✗ 는 없어야 정상입니다
pnpm status
```

- `pnpm install` — 의존성 설치.
- `cp .env.example .env` — 환경변수 스켈레톤 복사. 기본값 `HERALD_STORAGE_MODE=local`이라
  그대로 두면 `drive:init`/`sheet:init`/`targets:list`/`history:record`/`impressions:record`/`metrics:record`/`kol-telegram:record`/`x:reconcile`/`x:link`는 스킵되지만 나머지는
  전부 동작합니다 — `pnpm drive:publish`도 포함해서, 결과물은 `output/publish/local/`에 쌓입니다.
  **`DATABASE_URL`은 비워두면 안 됩니다** — `pnpm doctor`가 `✗ Database`로 표시하고
  `pnpm status`는 아예 실패합니다.
- `pnpm db:import --yes` — 스키마를 만듭니다(그리고 `output/`에 뭔가 있으면 가져옵니다).
  새 클론이면 `output/`이 비어 있어서 스키마만 생깁니다.
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

`--approve`를 붙이면 상태가 `approved`로 바뀌고 동시에 few-shot 코퍼스(데이터베이스의
`few_shot_examples` 테이블)에 예시로 승격됩니다 — 다음 배치의 번역 품질이 이 예시를 참고해 조금씩
좋아집니다.

## 4. 우리 팀에 맞추기

`pnpm config:init`이 만든 스티어링 파일들은 전부 git에 추적되지 않습니다
([`artifacts.md`](artifacts.md) §1) — 자유롭게 고쳐서 우리 팀만의 것으로 만들면 됩니다.
**내용은 비어 있는 뼈대입니다** (용어집은 `[]`). 여기에 여러분 팀의 규칙을 채워 넣는 것이
정상 경로입니다.

> Mantle KR 팀원이라면 `config:init` 대신 담당자에게 실제 파일을 받으세요 —
> [`setup/steering.md`](setup/steering.md).

- `translation/glossary.json` — 고유명사·용어 번역 규칙
- `translation/glossary-dismissed.json` — 주간 `pnpm glossary:mine`이 올리는 후보 중 사람이
  "아니오"라고 한 것들(비어 있는 게 정상 시작 상태)
- `translation/style-guide.md` — 번역 톤·문체 가이드
- `translation/locale.json` — 로케일 설정
- `conversion/{x,announcement,kakao_notice,explainer,casual,kol,pr}.md` — 타입별 변환 스티어링

이 파일들은 로컬에만 존재하는 팀 자산입니다. 커밋되지 않으니 백업이 필요하면 직접 관리하세요.

## 5. local → cloud 승격

로컬에서 감이 잡혔고 결과물을 Google Drive/Lark Drive에 실제로 보관하고 싶다면:

1. [`setup/google-drive.md`](setup/google-drive.md)와
   [`setup/lark.md`](setup/lark.md)를 따라 Google/Lark 자격 증명을
   채웁니다.
2. `.env`에서 `HERALD_STORAGE_MODE=cloud`로 바꿉니다.
3. `pnpm doctor --live`로 실제 토큰 발급과 권한(스코프)까지 확인합니다.
4. Drive 폴더나 Google Sheet가 아직 없다면 `pnpm drive:init`(Drive 폴더 생성)과
   `pnpm sheet:init`(Google Sheet 생성)을 실행하고, 콘솔에 출력된 id를 `.env`에 붙여넣습니다
   ([`artifacts.md`](artifacts.md) 참고).
5. `pnpm drive:publish`를 실행합니다.

`drive:publish`는 동기화 원장(`output/publish/state.json`)을 확인해 아직 올라가지 않은 항목은
새로 올리고, 내용이 그대로인 항목은 건너뜁니다. `local` 모드로 지내는 동안 이미 `target: "local"`
행이 원장에 쌓여 있겠지만, `google`(그리고/또는 `lark`)은 완전히 별개의 키이므로 상관없습니다 —
`local` 모드에서 쌓인 번역 백로그 전체가 이 한 번의 실행으로 새로 업로드됩니다. 승인 이후 내용이
바뀐 항목(`stale`)은 Google Drive에서는 기존 파일을 그 자리에서 갱신합니다 — 자세한 동작(Lark의
제약, 레거시 행의 예외)은 [`team-runbook.md`](team-runbook.md) §4를 참고하세요.

## 6. 다음으로

- 명령이 정확히 무엇을 읽고 쓰는지 궁금하면 → [`artifacts.md`](artifacts.md)
- 이 프로젝트가 무엇을 하고 무엇을 하지 않는지 궁금하면 → [`capabilities.md`](capabilities.md)
- Mantle KR 팀 내부 운영자로서 주간 루틴·장애 대응이 궁금하면 → [`team-runbook.md`](team-runbook.md)
- 검수 담당자에게 화면 사용법을 안내해야 하면 → [`review.md`](review.md)
