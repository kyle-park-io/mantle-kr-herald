# 환경변수 레퍼런스

`.env.example`은 "이 변수를 어디에 쓰는가"를 설명합니다. 이 문서는 그 옆의 질문에 답합니다 —
**안 넣으면 어떻게 되는가, 잘못 넣으면 어디서 멈추는가, 기본값은 무엇인가.**

값 설명이 필요하면 `.env.example`, 배포 절차가 필요하면 `DEPLOY.md`, 발급 방법이 필요하면
`docs/ko/setup/`을 보세요. 여기 적힌 동작은 전부 코드에서 확인한 것이고, 근거 파일을 같이
적어뒀습니다.

---

## 0. 먼저 — 실패하는 방식은 네 가지뿐입니다

| 방식 | 의미 |
|---|---|
| **기동 거부** | 프로세스가 뜨지 않습니다. 한 줄 메시지에 고치는 법이 같이 나옵니다. 제일 좋은 실패입니다 |
| **명령 실패** | 그 명령만 실패합니다. 다른 명령은 영향 없습니다 |
| **스킵 (exit 0)** | 아무 일도 안 하고 정상 종료합니다. 실패가 아니라 "이 모드에서는 할 일이 없음"입니다 |
| **조용한 축소** | 뜨고, 돌고, 기능 하나가 조용히 빠집니다. **가장 위험한 것** — 아래에서 ⚠로 표시했습니다 |

그리고 실행 프로파일 세 가지 (`.env.example` 맨 위 표와 같습니다):

- **A** = `pnpm serve` + `HERALD_STORAGE_MODE=local` — 시작 단계. 클라우드 크레덴셜 0개로 전체 파이프라인이 돕니다
- **B** = `pnpm serve` + `cloud` — 로컬 운영자
- **C** = Vercel 배포 — **항상 cloud**. `local`이면 기동을 거부합니다

---

## 1. 항상 필요한 것 — 없으면 대시보드가 안 뜹니다

이 여섯 개는 A·B·C 전부에서 필수고, 전부 **기동 거부**입니다. `pnpm serve`는 데이터베이스에
연결하기 *전에* 검사합니다(`src/cli/serve.ts:25-27`) — 잘못된 설정을 DDL 실패가 아니라 한 줄
메시지로 알게 하려고 일부러 그 순서입니다.

### `DATABASE_URL`

- **무엇** — 파이프라인의 기록 원본이 사는 Postgres. 표준 libpq URL
- **기본값** — 없음
- **비어 있으면** — `Missing required environment variable: DATABASE_URL` + 고치는 법. 기동 거부
- **틀리면** — 여기서는 안 잡힙니다. 형식 검사를 하지 않고 그대로 `pg`에 넘깁니다. 연결 시점에 `ECONNREFUSED` 같은 드라이버 에러로 납니다
- **근거** — `src/config.ts:442`

> **`HERALD_STORAGE_MODE=local`이어도 필요합니다.** 두 "local"은 다른 축입니다 — 저장 모드는
> *발행 산출물*이 어디로 가느냐(`output/` vs Drive)고, 원장(번역·변환·렌더링·발송 이력)은
> 어느 모드에서든 Postgres에 있습니다. 24개 명령이 데이터베이스를 엽니다. `DATABASE_URL`
> 없이 도는 건 `config:init`·`glossary`·`archive`·`clean`·`tm:promote`·`auth:hash`
> 여섯 개뿐이고, 이것들은 `.env`조차 읽지 않습니다.
>
> 로컬 Postgres를 띄우는 법은 [`quickstart.md`](quickstart.md) §1.5에 있습니다.
> 스키마는 직접 만들지 않습니다 — `pnpm serve`·`db:import`·`db:export`가 기동할 때 멱등으로
> 적용합니다. 다만 **`doctor`와 `status`는 적용하지 않습니다**: 빈 DB에서는 `doctor`가
> `✗ Database — Schema not applied`로 알려주고, `status`는 `relation ... does not exist`로
> 실패합니다. 빈 DB에는 `pnpm db:import --yes`를 한 번 돌리세요.

> `pnpm status`·`pnpm doctor`는 접속 대상을 `host:port/dbname`으로만 출력합니다. URL에 박힌
> 비밀번호는 절대 출력하지 않습니다 (`describeDbTarget`, `src/config.ts:452`).

### `HERALD_DB_ENV`

- **무엇** — 위 URL이 **어느** 데이터베이스를 가리키는지. `production` 또는 `development`
- **기본값** — **없고, 앞으로도 없을 예정입니다.** URL만 봐서는 팀 공용 DB인지 내 노트북 DB인지 구분이 안 되므로 추론하지 않습니다
- **비어 있으면 / 다른 값이면** — 기동 거부. 유효값을 메시지에 같이 출력합니다
- **바뀌는 것** — `development`면 대시보드 상단에 `개발 데이터베이스` 배너가 뜹니다. 그게 전부입니다 — 동작은 같습니다
- **근거** — `src/config.ts:429`

### `HERALD_STORAGE_MODE`

- **무엇** — 승인 산출물이 어디에 보존되는가. `local` 또는 `cloud`
- **기본값** — 없음. 추론하지 않습니다
- **비어 있으면 / 다른 값이면** — 기동 거부 (`src/storage/mode.ts:18`)
- **`local`** — 전부 `output/` 아래. 클라우드 크레덴셜이 하나도 필요 없습니다. **§3을 통째로 비워둬도 됩니다**
- **`cloud`** — Drive가 기록 원본. `drive:publish`가 거기로 올리고, 시트 명령이 살아납니다
- **C(Vercel)에서 `local`이면** — **기동 거부.** `assertCloudStorage` (`api/[...path].ts`). 2026-08-03 이전에는 조용히 떠서 승인 문서를 함수의 임시 파일시스템에 쓰고, 업로드는 성공했다고 보고하고, 링크는 전부 죽어 있었습니다
- **`local`일 때 스킵되는 명령 7개** — `drive:init`, `sheet:init`, `targets:list`, `history:record`, `impressions:record`, `metrics:record`, `kol-telegram:record`. `<명령>: local mode — skipped (set HERALD_STORAGE_MODE=cloud to enable)`를 출력하고 **exit 0**입니다. 실패가 아니라 할 일이 없는 겁니다 (`src/cli/skipIfLocal.ts`)
- **`drive:publish`는 스킵되지 않습니다** — local 모드에서는 Drive 대신 파일시스템을 대상으로 삼아 계속 동작합니다

> `local` 모드에서 `--target google`이나 `--target both`를 주면 **스킵이 아니라 실패**합니다.
> 크레덴셜이 없으니 어차피 실패할 텐데 그걸 exit 0으로 감추는 게 이 설계가 고치려던 실패입니다
> (`src/cli/uploaders.ts:42`).

### `HERALD_AUTH_USERNAME` + `HERALD_AUTH_PASSWORD_HASH`

- **무엇** — 대시보드의 **하나뿐인** 공용 계정. 사람마다 하나가 아니라 팀 전체가 하나입니다
- **기본값** — 없음
- **둘 중 하나라도 비면** — 기동 거부: `No dashboard account configured`. 예전에는 없어도 떴는데, 지금은 로그인 말고 모든 라우트가 세션 뒤에 있어서 계정 없는 서버는 **아무도 못 들어가는 로그인 화면**을 인터넷에 띄우는 것과 같습니다 (`src/config.ts:228`)
- **만드는 법** — `pnpm auth:hash`. 비밀번호를 인자로 받지 않습니다(셸 히스토리·프로세스 목록에 남지 않게) — 프롬프트로 입력받고 붙여넣을 줄을 출력합니다. 12자 미만이면 거부합니다
- **아이디 프롬프트는 선택입니다.** 비워두면 `HERALD_AUTH_PASSWORD_HASH` 한 줄만 나옵니다. 아이디는 해시에 들어가지 않습니다 — `hashPassword()`는 비밀번호만 받고 소금은 매번 무작위이며, 로그인은 아이디와 비밀번호를 각각 상수시간 비교합니다(`src/domain/auth/credentials.ts:37`). 그래서 **아이디만 바꿀 때는 `HERALD_AUTH_USERNAME`만 고치면 되고 해시는 그대로 씁니다**
- **비밀번호 자체는 `.env`에 넣지 않습니다.** `HERALD_AUTH_PASSWORD_HASH`는 scrypt 해시라 알아도 못 들어갑니다
- **바꾸면** — 기존 세션은 안 끊깁니다(세션은 아래 시크릿으로 검증). 다만 옛 비밀번호는 즉시 막히니 **바꾸기 전에 팀에 알리세요**

### `HERALD_SESSION_SECRET`

- **무엇** — 로그인 성공 후 세션 쿠키에 서명하는 키(HMAC-SHA256)
- **기본값** — 없음
- **비어 있으면** — 기동 거부
- **32자 미만이면** — 기동 거부. 실제 길이를 메시지에 출력합니다 (`src/config.ts:262`)
- **만드는 법** — `openssl rand -hex 32`
- **바꾸면** — **전원 즉시 로그아웃**됩니다. 유출됐으면 그렇게 하세요 — 이 값을 아는 사람은 세션을 위조할 수 있습니다
- **세션 수명** — 2시간. 환경변수가 아니라 코드 상수입니다 (`src/domain/auth/session.ts:33`)

---

## 2. 로그인 잠금 — 기본값이 이미 맞습니다

`pnpm serve`는 127.0.0.1에만 바인딩하고 앞에 프록시가 없습니다. **A·B에서는 둘 다 건드릴 일이
없습니다.**

### `HERALD_TRUST_PROXY`

- **기본값** — 꺼짐. 문자열이 정확히 `true`(대소문자 무시, 공백 제거)일 때만 켜집니다
- **꺼져 있을 때** — 소켓의 실제 peer 주소로 IP별 잠금을 겁니다
- **켜져 있을 때** — `X-Forwarded-For`를 믿습니다
- **C(Vercel)에서 없으면** — **기동 거부** (`assertTrustProxy`, `api/[...path].ts`). Vercel Function에는 raw 소켓이 없어서, 이게 없으면 IP별 잠금이 *약해지는* 게 아니라 **키로 쓸 주소가 아예 없어집니다.** 전역 50회 백스톱만 남고 — 그건 낯선 사람 하나가 팀 전체 로그인을 조용히 막을 수 있는 상태입니다
- **A·B에서 켜면 안 되는 이유** — 앞에 프록시가 없으면 `X-Forwarded-For`는 그냥 클라이언트가 쓰는 텍스트입니다. 매 요청마다 다른 값을 위조하면 IP별 잠금이 **무력화**됩니다 (`src/adapters/web/clientIp.ts`)

### `HERALD_TRUST_PROXY_HOPS`

- **기본값** — `1` (서버 바로 앞에 리버스 프록시 하나. Vercel이 그 경우입니다)
- **언제 읽히나** — `HERALD_TRUST_PROXY=true`일 때만. 실질적으로 C에서만입니다
- **비워두세요** — hop을 추가로 넣은 게 아니라면 손댈 이유가 없습니다
- **양의 정수가 아니면** — **A·B·C 전부 기동 거부.** 읽히지도 않을 프로파일에서도 거부합니다 — 환경에 들어간 헛소리는 조용히 무시할 게 아니라 알려야 할 실수라는 판단입니다 (`src/config.ts:297`)

---

## 3. cloud 모드 — 여기가 ⚠ 조용한 축소 구간입니다

**B·C에서만 읽힙니다.** A에서는 전부 비워두세요.

> ⚠ **이 절의 변수들은 기동을 막지 않습니다.** `createDeps`가 설정 로딩을 try/catch로 감싸고,
> 실패하면 해당 발행 타깃을 목록에서 **그냥 뺍니다** (`src/app/createDeps.ts:140-156`). 서버는
> 정상적으로 뜨고, 대시보드는 멀쩡해 보이고, 그 타깃의 버튼만 비활성으로 보입니다. 에러는
> 어디에도 안 뜹니다. 확인하려면 대시보드 헤더의 **`local`/`cloud` 배지에 마우스를 올리거나**
> (§7) `pnpm doctor`를 도세요.
>
> 다만 그 카드의 `설정됨`은 **키가 있다**는 뜻이지 **키가 살아 있다**는 뜻이 아닙니다. 그건 같은
> 카드의 `키 응답` 절이 답합니다(§7).

### Google 인증 — 방식 하나를 고릅니다

| 변수 | 기본값 | 비고 |
|---|---|---|
| `GOOGLE_AUTH_MODE` | 없음 → **추론** | `oauth` \| `service_account`. 다른 값이면 그 자리에서 실패 |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | 없음 | 방식 A(OAuth)에 셋 다 필요 |
| `GOOGLE_SA_KEY_FILE` | 없음 | 방식 B. JSON 키 **파일 경로** |
| `GOOGLE_OAUTH_SCOPE` | `https://www.googleapis.com/auth/drive.file` | `pnpm google:auth`가 토큰을 **발급할 때만** 읽습니다 |

- **추론 규칙** — `GOOGLE_AUTH_MODE`가 있으면 그게 이깁니다. 없으면 refresh token이 있으면 `oauth`, 없고 SA 키가 있으면 `service_account`, 둘 다 없으면 실패 (`src/config.ts:83`)
- **개인 Gmail이면 OAuth 말고는 답이 없습니다.** 서비스 계정은 자기 저장 용량이 없어서 Workspace **공유 드라이브**에만 올릴 수 있습니다
- **`GOOGLE_SA_KEY_FILE`은 Vercel에 올리지 마세요** — 파일 경로인데 함수에 그 파일이 없습니다
- **`GOOGLE_OAUTH_SCOPE`를 바꿔도 즉시 효과가 없습니다.** 토큰은 발급될 때의 스코프를 그대로 갖고 다닙니다 — `pnpm google:auth`를 다시 돌려야 합니다. 지금 실제로 부여된 스코프는 `pnpm doctor --live`가 출력합니다

### Google Drive 폴더

| 변수 | 기본값 | 없으면 |
|---|---|---|
| `GDRIVE_REVIEW_FOLDER_ID` | 없음 | ⚠ **google 발행 타깃이 통째로 사라집니다** |
| `GDRIVE_APPROVED_FOLDER_ID` | 없음 | ⚠ 위와 동일 (둘 중 하나만 없어도) |
| `GDRIVE_SENT_FOLDER_ID` | 없음 | `send:channels`의 Google 사본만 안 만들어집니다. **발송 자체는 정상** |
| `GDRIVE_CONFIG_FOLDER_ID` | 없음 | `config:push`가 첫 실행에 폴더를 만들고 id를 출력합니다 |
| `GDRIVE_STATE_FOLDER_ID` | 없음 | `state:push`가 첫 실행에 만들고 출력합니다 |
| `GDRIVE_SHARE_EMAILS` | 빈 목록 | `drive:init`만 읽습니다. 비어 있으면 폴더가 나만 보이는 상태로 남습니다 |
| `GDRIVE_PARENT_FOLDER_NAME` | `Mantle KR Herald` | `drive:init`만 읽습니다 |

> `GDRIVE_CONFIG_FOLDER_ID`와 `GDRIVE_STATE_FOLDER_ID`를 **섞지 마세요.** 앞엣것은 팀과 공유하는
> 스티어링 설정이고, 뒤엣것은 **이 컴퓨터가 무엇을 이미 보냈는지**의 기록입니다. 남의 state
> 스냅샷을 복구하면 이미 보낸 방이 안 보낸 걸로 읽힙니다.

### Lark Drive — 전부 선택

| 변수 | 없으면 |
|---|---|
| `LARK_DRIVE_REVIEW_FOLDER_TOKEN` / `_APPROVED_FOLDER_TOKEN` | ⚠ **lark 발행 타깃이 사라집니다.** `LARK_APP_ID`/`_SECRET`도 같이 필요합니다 |
| `LARK_DRIVE_SENT_FOLDER_TOKEN` | Lark 사본만 안 만들어집니다. 발송은 정상. 자동 생성 없음 — `sent` 폴더를 직접 만들어 토큰을 붙여넣으세요 |
| `LARK_WORKSPACE_URL` | 대시보드에 "Lark에서 열기" 링크가 안 뜹니다. 발행은 영향 없음 |

### Google Sheet

| 변수 | 기본값 | 없으면 |
|---|---|---|
| `GSHEET_ID` | 없음 | `sheet:init`·`targets:list`·`history:record`·`impressions:record`·`metrics:record`가 **실패**합니다 (cloud 모드에서. local이면 그 전에 스킵됨) |
| `GSHEET_QA_ID` | 없음 | 대시보드 헤더의 QA 시트 링크만 사라집니다 |

> 시트 링크는 **절대 대시보드를 무너뜨리지 않습니다.** id가 없으면 링크를 숨길 뿐입니다
> (`loadSheetLinks`, `src/config.ts:163` — 이 함수는 던지지 않습니다).
> 워크북 **하나**에 모든 탭을 둘 수 있습니다 — `history`와 `x-performance`는 각자 알아서
> 탭을 만듭니다. `targets`만 손으로 채우는 탭입니다.

---

## 4. 수집 — 쓰는 명령에서만 필요합니다

**배포본은 수집하지 않습니다.** 수집은 전부 CLI 작업이라, C에서 이 절은 대시보드 배지 호버
카드의 표시(§7)에만 영향을 줍니다.

| 변수 | 기본값 | 없으면 |
|---|---|---|
| `TWITTERAPI_IO_KEY` | 없음 | `pnpm collect` **실패**. 다른 명령은 무관 |
| `REFERENCE_X_HANDLE` | **`0xMantleKR`** | 기본값으로 동작합니다. `tm:measure`·`collect:reference`·`metrics:record`가 읽습니다. `@`는 붙여도 떼고 씁니다 |
| `LARK_APP_ID` + `LARK_APP_SECRET` | 없음 | `collect-lark`·`lark:chats`·`lark:send` 실패. **Lark Drive 발행도 같이 죽습니다**(§3) |
| `LARK_CHAT_IDS` | 없음 | `collect-lark` **실패**. `lark:chats`는 앱 크레덴셜만으로 도니까 **첫 실행 때는 비워두는 게 맞습니다** — 그걸로 id를 찾습니다. `lark:send`는 동작하되 `--chat`이 필수가 됩니다 |
| `LARK_BASE_URL` | **`https://open.larksuite.com`** | 기본값(Larksuite 인터내셔널). 중국 Feishu면 `https://open.feishu.cn` |

번역·변환·포맷 단계는 **외부 API를 하나도 부르지 않습니다.** 이 절이 통째로 비어 있어도 돕니다.

---

## 5. 발송 — 보내는 채널만

| 변수 | 기본값 | 없으면 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 없음 | `send:channels --target telegram` 실패 |
| `TELEGRAM_CHAT_ID_COMMUNITY` | 없음 | **그 방만** 조용히 건너뜁니다. 대시보드가 빠진 변수 이름을 알려줍니다 |
| `TELEGRAM_CHAT_ID_DEV` | 없음 | 위와 동일 |
| `TYPEFULLY_API_KEY` + `TYPEFULLY_SOCIAL_SET_ID` | 없음 | `send:channels --target x` 실패 |
| `X_PREMIUM` | **`false`** | ⚠ 아래 참고 |

> **방별 chat id에는 폴백이 없습니다.** 예전엔 있었는데, 그게 절반만 옮긴 `.env`에서 데브방
> 원고를 커뮤니티 방으로 보냈습니다. 지금은 방을 지목 못 하면 그 방을 건너뜁니다
> (`src/config.ts:188`).

### ⚠ `X_PREMIUM`

- `true`일 때만 켜집니다. 그 외 모든 값은 꺼짐
- **꺼짐** — 280 가중 글자수 제한(한글·이모지는 2로 셉니다)
- **켜짐** — 25,000자 롱폼 허용
- **이게 위험한 이유** — 계정에 X Premium이 있는데 이 변수를 안 옮기면, 로컬에서 잘 나가던 롱폼이 **그 환경에서만** 거부됩니다. 발행 쿼터가 월 15건이라 디버깅 비용이 실제 쿼터로 나갑니다
- **근거** — `src/config.ts:402`

---

## 6. 대시보드와 배포

### `PORT`

- **기본값** — `5757` (`pnpm serve`), `5758` (`pnpm serve:hosted`)
- **Vercel에서는 무시됩니다** — 플랫폼이 정합니다. C에 등록할 필요 없습니다

### `HERALD_DEPLOYMENT_ORIGIN` — C 전용

- **기본값** — 없음. 절대 추론하지 않습니다
- **무엇** — 이 배포가 대시보드를 서비스하는 **정확한** 오리진. scheme + host만
- **CSRF 가드가 이 값과 정확히 일치하지 않는 오리진의 쓰기 요청을 전부 403으로 막습니다**
- **없으면 / 형식이 틀리면 기동 거부** — 네 가지를 각각 다른 메시지로 거부합니다: 비어 있음, URL이 아님, **https가 아님**, 경로·쿼리·프래그먼트가 붙어 있음 (`src/config.ts:331`)
- **끝 슬래시는 붙이지 마세요.** `https://x.vercel.app/`는 경로가 있는 것으로 거부됩니다
- **왜 기본값이 없나** — 배포 주소는 배포하기 전엔 존재하지 않고, 설정이 없다고 아무 오리진이나 받아주는 CSRF 허용목록은 **가드가 없는 것보다 나쁩니다** (있는 것처럼 보이니까)

### `HERALD_SENDS_ENABLED` — C 전용

- **기본값** — 닫힘. 정확히 `true`일 때만 열립니다
- **닫혀 있을 때** — 1차·2차 승인은 정상 동작하고, 발송만 한국어 사유와 함께 거부됩니다. 대시보드에 `발송 · 잠김`으로 보이고 상단에 배너가 뜹니다
- **`pnpm serve`는 이 값을 읽지 않습니다** — 로컬은 **항상** 보냅니다. 예전과 같습니다. 로컬에서 `[발송]`을 누르면 진짜로 나갑니다
- **영향 없는 것** — `pnpm send:reconcile`과 대시보드의 `[게시 확인]`. 이 둘은 Typefully를 읽어서 이미 있는 행에 URL을 붙일 뿐입니다
- **바꾼 뒤에는 재배포해야 합니다** — 변수만 바꿔서는 반영되지 않습니다
- **근거** — `src/config.ts:363`, `src/app/createDeps.ts:102`

---

## 7. 확인하는 법

```bash
pnpm doctor          # 크레덴셜 존재 여부 — 외부 호출 없음
pnpm doctor --live   # 실제로 호출해봄. 부여된 Google 스코프, Typefully 잔여 쿼터까지
pnpm status          # 접속 대상 DB와 단계별 건수
```

화면에서도 같은 걸 볼 수 있습니다. 대시보드 헤더의 **`local`/`cloud` 배지에 마우스를 올리면**
호버 카드가 뜨고, 수집·발행·발송·데이터 네 묶음으로 항목마다 **`설정됨`** 또는 **`키 없음`**을
보여줍니다 (`web/src/App.tsx:262`). §3의 조용한 축소를 잡는 데는 이게 제일 빠릅니다 — 발행 타깃
버튼이 비활성이면 그 타깃 설정이 로딩에 실패한 것입니다.

`키 없음` 항목은 `.env`에 키를 채우고 **서버를 다시 실행**하면 활성화됩니다. 대시보드에서
모드나 키를 바꿀 수는 없습니다.

### 같은 카드의 `키 응답` — 있는지가 아니라, 답하는지

`설정됨`은 **키가 있다**는 뜻입니다. 2026-08-10에 배포본의 Google·Typefully·Telegram이 나흘 동안
401을 답하는 내내 헤더는 세 개 다 `설정됨`이었습니다. 틀린 표시가 아니라 `/api/status`가 볼 수 있는
게 존재 여부뿐이라 그랬고, 그래서 아무 도움이 안 됐습니다. 그 자리를 같은 카드의 **`키 응답`** 절이
메웁니다 — 배포본이 **마지막으로 자기 자격 증명을 실제로 찔러본 결과**입니다.

- **머리줄** — `N개 모두 응답 · 2시간 전 확인`. `N`은 이 배포본이 **실제로 찔러본** 키 개수로, 설정 안
  된 통합은 세지 않습니다 — Telegram만 설정한 배포본이면 `3개 모두 응답`입니다. 하나라도 죽어 있으면
  `N개 중 1개 응답 없음 · …`. 설정된 키가 하나도 없으면(신설 배포본, 또는 로컬 `pnpm serve`) 찔러볼
  게 없었다는 뜻이라 `0개 모두 응답`이라 하지 않고 `설정된 키 없음 · 2시간 전 확인`이라 합니다
- **죽은 키마다 한 줄** — 한국어 이름(`Google 인증`·`Drive 검수 폴더`·`Drive 승인 폴더`·
  `Google Sheet`·`Lark`·`Typefully`·`Telegram`)과 **이유**를 나란히 놓습니다. 이유를 그대로 보여주는
  게 요점입니다 — `400 invalid_grant`는 토큰이 폐기·만료된 것이고 `401`은 클라이언트 자격증명이 안
  맞는 것이라, 401을 보고 토큰을 다시 발급하면 같은 자리를 맴돕니다
  ([`deploy.md`](deploy.md)의 "Google OAuth 토큰이 7일마다 죽을 때")
- **`[지금 확인]` 버튼** — 배포본에 다시 찔러보게 하고 결과를 다시 읽어옵니다. 도는 동안은
  `확인 중…`이고, 실패하면 카드 안에 붉은 줄로 뜨면서 **직전 관측은 화면에 그대로 남습니다.**
  마지막으로 알던 사실이 빈 화면보다 낫습니다. 버튼은 관측이 한 번도 없는 배포본에서도 그대로
  있습니다 — 첫 클릭이 실패해도 카드 안에서 그렇다고 말합니다

### 배지 옆 ⚠ 칩 — 할 말이 있을 때만 뜹니다

모드 알약(`local`/`cloud`)은 손대지 않았습니다. 저장 모드와 건강 상태는 색 하나를 나눠 쓰면 안 되는
두 사실이라, 상태는 **알약 옆에 붙는 별도 칩**으로 나옵니다. 그리고 문제가 없으면 **아무것도 안
뜹니다** — 1년 내내 초록인 표시등은 정작 빨개진 날에도 아무도 안 봅니다.

| 마지막 관측 | 칩 |
|---|---|
| 설정된 키가 모두 응답, 또는 설정된 키가 아예 없음 | 없음. 헤더가 예전과 똑같습니다 |
| **발행** 키(Google 인증·Drive 두 폴더·Lark)가 죽음 | 빨강 `⚠ 발행 키 1개 응답 없음` |
| **발송** 키(Typefully·Telegram)가 죽었고 `HERALD_SENDS_ENABLED`가 열림 | 빨강 `⚠ 발송 키 1개 응답 없음` |
| 같은 상황인데 발송이 닫혀 있음 | 노랑, 문구는 같음 |
| Sheet만 죽음 | 노랑 `⚠ 시트 응답 없음` |
| 관측이 26시간보다 오래됨 | 노랑 `⚠ 확인 1일 전` |
| 관측이 한 번도 없음 | 없음 |

등급은 그 키가 **무엇에 쓰이는지**로 갈립니다. `deploy:smoke`·`pnpm creds:check`가 쓰는 것과 **같은
표**(`src/doctor/liveSeverity.ts`)이고, 판정도 서버에서 한 번만 합니다 — 화면은 색과 문구만 고릅니다.
그래서 배포에서 fail인 자격 증명이 보드에서 warn으로 보이는 일은 있을 수 없습니다. **미설정은 죽은
게 아닙니다** — 존재 여부는 위쪽 `설정됨`/`키 없음` 목록의 몫이고, Telegram만 쓰는 설치가 Lark가
없다고 빨개지면 안 됩니다.

**26시간의 근거는 타이머입니다.** `deploy/herald-creds.timer`가 매일 06:23에 도니까 건강한 관측은
길어야 24시간 + 실행 시간이고, 26시간은 한 번 걸렀을 때 + 여유입니다. 죽은 것과 오래된 것은 다른
상태라 다르게 읽혀야 합니다 — 오래됐다는 건 뭔가 잘못됐다는 증거가 아니라 **아무도 안 들여다봤다는
증거**입니다. 이걸 화면이 말해야 하는 이유는 유닛의 `OnFailure=` 훅이 바로 이 경우를 못 잡기
때문입니다 — 이 컴퓨터가 그냥 꺼져 있으면 실패하는 게 없고, 텔레그램도 안 오고, 그 침묵이 보이는
곳은 보드뿐입니다. 다만 **하루가 넘어가면 나이는 `1일 전`처럼 거칠게만 나옵니다**(수집 카드가 쓰던
나이 표기를 그대로 쓰는데, 그게 하루 단위로 버립니다) — 27시간과 47시간이 화면에서 똑같아 보인다는
뜻입니다.

**관측을 기록하는 건 라우트 하나뿐입니다.** `GET /api/diagnostics/live`가 찔러본 직후 자기가 본 걸
`credential_liveness` 한 행에 덮어씁니다. 그래서 화면에 뜨는 건 **마지막으로 물어본 사람이 남긴
것**입니다 — 매일 도는 `pnpm creds:check`, 배포마다 도는 `pnpm deploy:smoke`, 그리고 `[지금 확인]`
셋이 같은 행을 갱신합니다. 새 스케줄러도 새 명령도 없습니다. 기록은 **최선 노력이고 2초로
묶여** 있어서, 데이터베이스가 멈춰 있어도 진단 라우트가 그 때문에 늦어지거나 실패하지 않습니다.

`pnpm doctor --live`는 이 행에 **쓰지 않습니다.** 그건 이 컴퓨터의 `.env`를 검사하는 거라, 배포본을
설명한다고 주장하는 행에 들어가면 안 됩니다.

**카드에 `키 응답` 절이 아예 없으면** 그 데이터베이스는 한 번도 관측된 적이 없는 것입니다 —
`pnpm db:migrate`를 아직 안 돌렸거나(새 `credential_liveness` 표가 필요합니다), 배포도 `creds:check`도
아직 한 번도 안 돈 설치입니다. 에러도 아니고 "다 정상"도 아니라 **아직 아무도 안 봤다**는 뜻이고,
화면은 예전 그대로 나옵니다. `[지금 확인]`을 한 번 누르면 채워집니다.

---

## 관련 문서

- `.env.example` — 변수별 상세 설명과 상단의 프로파일 표
- `DEPLOY.md` — Vercel 배포 런북 (`vercel env add` 명령 포함)
- `docs/ko/setup/` — 크레덴셜 발급 절차 (Google Drive, Lark, 채널)
- `docs/ko/quickstart.md` §5 — local → cloud 승격 절차
