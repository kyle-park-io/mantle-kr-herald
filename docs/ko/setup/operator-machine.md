# 운영 머신 재구성 — 노트북을 바꿨을 때

**운영자 머신 하나를 처음부터 다시 세우는 절차입니다.** 조각들은 원래 여러 문서에 있었지만 하나의
흐름으로 묶인 곳이 없어서, 실제로 갈아엎었을 때 세 문서를 오가며 순서를 유추해야 했습니다. 이 문서가
그 순서이고, 2026-08-17에 실제로 한 번 밟아 본 것입니다.

**여기서 "운영 머신"은 systemd 타이머 여섯 개가 도는 컴퓨터**입니다. 호스팅 대시보드(Vercel)를
세우는 절차가 아닙니다 — 그건 [`vercel.md`](vercel.md), 이미 올라간 뒤의 운영은
[`deploy.md`](../deploy.md)입니다.

## 먼저 알아야 할 것 — `.env`는 Vercel에서 복구되지 않습니다

**이게 이 문서에서 제일 중요한 한 줄입니다.** Vercel에 자격증명이 다 들어 있으니 거기서 받아오면
되겠다고 생각하기 쉽고, 실제로 그렇게 시도했다가 시간을 버렸습니다.

`vercel env pull`은 **sensitive로 등록된 값을 돌려주지 않습니다.** 값 자리에 문자열
`[SENSITIVE]`가 들어옵니다. 그리고 이 프로젝트의 자격증명은 거의 전부 sensitive입니다 — Google
OAuth 4개, `GDRIVE_*`, `GSHEET_*`, `LARK_*`, `TELEGRAM_*`, `TYPEFULLY_*`, `TWITTERAPI_IO_KEY`,
`HERALD_AUTH_PASSWORD_HASH`, `HERALD_SESSION_SECRET` 전부.

돌아오는 것은 non-sensitive뿐입니다: `DATABASE_URL`, `HERALD_DB_ENV`, `HERALD_STORAGE_MODE`,
`HERALD_DEPLOYMENT_ORIGIN`, `HERALD_TRUST_PROXY`, `HERALD_AUTH_USERNAME`,
`HERALD_INTAKE_ENABLED`, 그리고 Neon 통합이 넣은 `PG*`/`POSTGRES_*`.

> `~/.herald/prod.env`를 `vercel env pull`로 만드는 [`team-runbook.md` §6](../team-runbook.md)의
> 절차가 되는 이유가 이것입니다 — 거기 필요한 `DATABASE_URL`이 마침 non-sensitive거든요. 그 절차가
> 된다고 해서 `.env` 전체가 될 것이라고 넘겨짚지 마세요.

**그러니 `.env`는 본인이 가져와야 합니다.** 이 문서는 그것을 전제로 합니다. 가져온 뒤에 그것이
프로덕션과 어긋나지 않는지는 아래 6단계에서 확인합니다.

## 절차

### 1. 저장소와 의존성

```bash
git clone git@github.com:kyle-park-io/mantle-kr-herald.git
cd mantle-kr-herald
pnpm install
```

### 2. `.env` 가져오기

본인 백업에서 저장소 루트에 `.env`로 놓습니다. 없다면 [`.env.example`](../../../.env.example)을
복사해 채우되, **어느 값이 어디 것인지는 그 파일 맨 위의 프로파일 표**가 변수별로 말해 줍니다.

```bash
chmod 600 .env
```

**어느 쪽으로 놓든 권한을 확인하세요.** `cp .env.example .env`는 git 추적 파일의 모드를 물려받아
`644`로 생기고, 백업에서 복사해 온 파일도 어떻게 옮겼느냐에 따라 열려 있을 수 있습니다. 이 한 파일에
이 머신의 자격 증명이 전부 들어갑니다. 배포 트리 쪽 사본은 `deploy:freeze`가 알아서 `0o600`으로
쓰지만(`src/cli/deploy-freeze.ts`의 `modeFor`), 원본은 아무도 안 건드립니다 — `pnpm doctor`의
`.env permissions` 줄이 그래서 있습니다.

`DATABASE_URL`과 `HERALD_DB_ENV` 두 줄은 **이 머신의 로컬 데이터베이스**를 가리켜야 합니다 —
프로덕션 DSN을 여기 넣으면 안 됩니다([`team-runbook.md`](../team-runbook.md)가 그 이유를 적어
뒀습니다: 로컬 CLI 스물몇 개가 전부 프로덕션을 치게 되고, 더 나쁘게는 `db:import`의 프로덕션 거부가
꺼집니다). 로컬 DB가 없으면 [`quickstart.md` §1.5](../quickstart.md)가 컨테이너 한 줄로 띄웁니다.

대시보드 계정 세 개(`HERALD_AUTH_USERNAME`·`HERALD_AUTH_PASSWORD_HASH`·`HERALD_SESSION_SECRET`)는
**이 머신 것을 새로 만들어도 됩니다.** 프로덕션 것과 같을 필요가 없습니다:

```bash
pnpm auth:hash                          # 두 줄을 출력합니다
openssl rand -hex 32                    # HERALD_SESSION_SECRET
```

### 3. 스키마와 스티어링

```bash
pnpm db:import --yes    # 빈 DB에 스키마만 생깁니다 (멱등)
pnpm config:init        # translation/·conversion/ 스켈레톤 (기존 파일은 안 덮어씀)
```

**`config:init`이 만드는 것은 빈 껍데기입니다.** 실제 용어집·문체 규칙은
[`steering.md`](steering.md)가 받는 법을 설명합니다. `herald-backup` 타이머가 매일 Drive에
올려두므로, Google 자격증명이 `.env`에 들어온 뒤라면 대개 이 한 줄입니다:

```bash
pnpm config:pull
```

### 4. 점검

```bash
pnpm doctor
```

`✗`가 없어야 합니다. `⚠`는 안 쓰는 소스·채널의 자격증명이면 정상입니다. `Steering config`가
`present but empty`라면 3단계의 `config:pull`이 아직입니다.

### 5. 프로덕션 DB 접속 정보

스케줄러만 쓰는 파일이고, 저장소의 `.env`와 **분리해서** 둡니다. 절차는
[`team-runbook.md` §6 설치](../team-runbook.md)에 있습니다 — `vercel env pull`로 받아
`DATABASE_URL` 한 줄만 뽑고 `HERALD_DB_ENV=production`을 붙여 `~/.herald/prod.env`(권한 600)로
만듭니다. 값이 화면에 찍히지 않도록 파일에서 파일로만 옮깁니다.

확인은 값이 아니라 구조로 합니다:

```bash
cut -d= -f1 ~/.herald/prod.env      # DATABASE_URL, HERALD_DB_ENV 두 줄이어야 합니다
```

### 6. `.env`가 프로덕션과 어긋나지 않는지 확인

```bash
pnpm env:diff
```

양쪽이 다 가져야 하는 자격증명 스물두 개의 **이름**을 대조합니다. 한쪽에만 있으면 어느 쪽에 없는지
말해 줍니다.

**값은 비교하지 않고, 할 수도 없습니다** — 위에서 본 `[SENSITIVE]` 때문입니다. 읽을 수 있는 값들은
오히려 양쪽이 **달라야 정상**이고요(이 머신은 `local` 저장 모드·개발 DB·자기 대시보드 계정,
배포는 `cloud`·프로덕션·팀 계정). 비밀이 실제로 살아 있는지는 다른 질문이며, 이 머신 쪽은
`pnpm doctor --live`, 배포 쪽은 `pnpm creds:check`가 답합니다.

### 7. 스케줄러

여기부터는 [`team-runbook.md` §6](../team-runbook.md)이 SSOT입니다. 배포 체크아웃 클론,
`~/.herald/bin` 심볼릭 링크, 수집 워터마크 심기, 유닛 파일 열세 개 복사, 손으로 한 번 실행,
`enable`, `loginctl enable-linger` 순서입니다.

> **재설치라면 워터마크와 번역 floor를 같게 맞추지 마세요.** 최초 설치 때만 같습니다. 재설치에서는
> 워터마크는 프로덕션이 이미 수집한 최신 글 시각으로 올리고, `HERALD_TRANSLATE_SINCE`는 유닛 값
> 그대로 둡니다 — 올리면 수집됐지만 아직 번역되지 않은 항목들이 floor 아래로 떨어져 영구히
> 버려집니다. runbook의 해당 절이 실제 사고와 함께 적어 뒀습니다.

## 이 머신에만 있는 값들

`.env`의 일부는 **Vercel에 없는 게 정상**입니다. 배포가 읽지 않기 때문입니다:

| 변수 | 읽는 곳 |
| --- | --- |
| `TELEGRAM_CHAT_ID_OPS` | `deploy/herald-notify-failure.sh` — 스케줄러 실패 알림 |
| `LARK_CHAT_IDS` · `LARK_BASE_URL` | `pnpm collect-lark` |
| `REFERENCE_X_HANDLE` | `collect:reference`·`x:reconcile`·`metrics:record`·`x:link` (기본값 `0xMantleKR`) |
| `HERALD_SMOKE_USERNAME` · `HERALD_SMOKE_PASSWORD` | `pnpm deploy:smoke` — 배포된 대시보드에 로그인하는 클라이언트 쪽 값 |

`pnpm env:diff`는 이들을 대조 대상에서 빼므로, 없다고 경고하지 않습니다. 반대로
`HERALD_OUTPUT_DIR`·`HERALD_TRANSLATE_SINCE`·`HERALD_WATCH_BATCH`는 `.env`가 아니라 **유닛 파일이**
설정합니다.

## 백업해 둘 것

재구성이 막히는 지점은 언제나 `.env`입니다. 나머지는 되찾을 길이 있습니다 — 스티어링은 Drive
(`herald-backup`의 `config:push`), 프로덕션 DSN은 Vercel, 코드는 git. **`.env`만 사본이 하나뿐이면
다음 사고는 복구 불가입니다.** 어디에 두든, 이 파일이 어디 있는지는 정해 두세요.
