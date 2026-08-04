# Vercel 호스팅 배포 셋업 가이드

팀이 운영자의 터미널이 아니라 **URL에서** 1차·2차 검수와 승인, (플래그를 열면) 발송까지 하도록
대시보드를 Vercel에 올리는 절차입니다. 로컬 `pnpm serve`를 대체하는 게 아니라 **엔트리포인트를
하나 더 두는 것**이고, 둘은 같은 PostgreSQL을 봅니다.

각 변수의 의미와 그렇게 정한 이유는 `.env.example` §5–§6에 적혀 있으니, 여기서는 **무엇을 어떤
순서로 하는지**만 다룹니다.

**현재 배포 주소: `https://mantle-kr-herald.vercel.app`**

> ### 이 문서는 **처음 한 번** 세우는 절차입니다
>
> 이미 올라간 뒤의 일 — 재배포, 비밀번호 교체, 발송 열기, 롤백, "배포가 정말 살아 있는지"
> 확인 — 은 [`deploy.md`](../deploy.md)에 있습니다. 거기에는 배포하기 전에는 보이지 않는
> 함정 세 가지도 정리돼 있습니다.

> **먼저 읽으세요** — [스티어링 설정 받기](./steering.md). 용어집·번역 메모리는 git에 없습니다.

## 0. 먼저 알아야 할 세 가지

**① git push로 배포되지 않습니다.** `vercel.json`의 `git.deploymentEnabled: false`로 프리뷰
배포를 꺼 두었습니다. 배포는 항상 명시적으로 실행합니다. 그래서 **이 프로젝트가 서비스하는 오리진은
정확히 하나**이고, 그 사실이 아래 CSRF 설정을 단순하게 만들어 줍니다.

**② `pnpm serve`로는 호스팅 화면을 미리 볼 수 없습니다.** 로컬 엔트리포인트는 `routes: "local"`이라
`[변환 준비]`가 **항상 있고** 발송이 **항상 열려** 있습니다. 호스팅이 다르게 동작하는 딱 두 가지가
바로 그 둘이라, `pnpm serve`는 원리적으로 그 차이를 보여주지 못합니다. 대신 **`pnpm serve:hosted`**를
쓰세요 — Vercel Function이 호출하는 것과 같은 `createHandler`를 그대로 구동합니다.

**③ 발송은 닫힌 채로 배포됩니다.** 첫 배포에서 1차·2차 승인은 되지만 발송은 한국어 사유와 함께
거부됩니다. 팀이 승인 흐름을 신뢰하게 된 뒤 환경변수 하나를 바꿔 여는 구조입니다(§6).

## 1. PostgreSQL 준비

`DATABASE_URL`을 얻습니다. Vercel Postgres, Neon, Supabase 등 `pg` 드라이버로 TCP 접속되는
곳이면 됩니다(엣지 런타임이 아니라 Node 런타임을 쓰는 이유가 이것입니다).

개발용 데이터베이스를 따로 둘 거라면 `HERALD_DB_ENV`로 구분합니다. **개발 데이터베이스에는 운영
데이터를 복사하지 않습니다** — 테스트 픽스처만 넣습니다.

## 2. 스키마 적용과 기존 데이터 이관

**별도의 `pnpm db:schema` 명령은 없습니다.** 스키마는 `pnpm db:import`가 테이블을 건드리기 전에
적용합니다.

```bash
DATABASE_URL=... pnpm db:import
```

파일 기반으로 운영해 온 기존 데이터(`output/**`)가 있다면 이 명령이 함께 옮깁니다. 빈 데이터베이스로
시작해도 같은 명령으로 스키마만 만들어집니다.

> 이관 전에 `pnpm state:push`로 운영 상태 스냅샷을 한 번 떠 두세요. 다시 만들 수 없는 것들
> (사람이 검수한 글, 2차 승인 상태, 방별 포크, 발송 원장)이 거기 들어 있습니다.

## 3. 대시보드 계정과 세션 비밀키 만들기

```bash
pnpm auth:hash                 # 비밀번호를 에코 없이 입력받아 붙여넣을 줄을 출력
openssl rand -hex 32           # HERALD_SESSION_SECRET
```

아이디 프롬프트는 **선택**입니다. Vercel에서는 `HERALD_AUTH_USERNAME`을 아래에서 따로 등록하니
그냥 엔터를 쳐서 넘기면 해시 한 줄만 나옵니다.

`auth:hash`가 출력하는 것은 scrypt 해시입니다 — **비밀번호 자체는 어디에도 적지 마세요.** 계정은
팀이 공유하는 하나입니다(사람마다 하나가 아닙니다).

> **로테이션 주의** — 계정을 바꿔도 기존 세션은 즉시 끊기지 않지만(세션은 `HERALD_SESSION_SECRET`으로
> 검증합니다), **옛 비밀번호는 즉시 막힙니다.** 미리 팀에 알리지 않으면 다음에 로그인하는 사람이
> 이유 없는 거부만 보게 됩니다.

## 4. Vercel 프로젝트 만들고 환경변수 넣기

빌드 설정은 `vercel.json`에 이미 있습니다(`buildCommand: pnpm build:web`,
`outputDirectory: web/dist`, `regions: ["sin1"]`). 대시보드에서 따로 만질 필요가 없습니다.

> **리전은 싱가포르 `sin1`로 고정돼 있습니다.** 데이터베이스와 함수가 다른 대륙에 있으면 화면
> 하나를 그릴 때마다 쿼리가 그만큼 왕복합니다. 한국에서 가장 가까운 조합이 그것이라
> **데이터베이스도 같은 리전에 만드세요**(§1). Vercel 마켓플레이스의 Neon이 주는 아시아
> 리전은 `sin1`과 시드니뿐이고, Neon 쪽 리전은 **생성 후 변경할 수 없습니다.**

환경변수는 `.env` 파일이 아니라 **Vercel 프로젝트 환경변수**로 넣습니다. 대시보드에 들어갈
필요 없이 CLI로 됩니다 — 값을 인자로 주지 않으면 프롬프트로 물어서 셸 히스토리에 남지 않습니다:

```bash
npx vercel env add HERALD_SESSION_SECRET production --sensitive
npx vercel env add HERALD_STORAGE_MODE production      # cloud
npx vercel env ls production                            # 이름만 — 값은 안 보여줍니다
```

| 변수 | 필수 | 값 |
|---|---|---|
| `DATABASE_URL` | ✅ | §1에서 얻은 접속 문자열 |
| `HERALD_DB_ENV` | ✅ | `production`. **선택이 아닙니다** — `loadDbEnv()`가 없으면 던져서 함수가 안 뜹니다 |
| `HERALD_STORAGE_MODE` | ✅ | **반드시 `cloud`** — 로컬 값을 그대로 복사하면 안 됩니다. 아래 설명 |
| `HERALD_AUTH_USERNAME` | ✅ | §3 출력 |
| `HERALD_AUTH_PASSWORD_HASH` | ✅ | §3 출력 |
| `HERALD_SESSION_SECRET` | ✅ | §3 출력 (32자 이상) |
| **`HERALD_TRUST_PROXY`** | ✅ | **반드시 `true`** — 아래 설명 |
| `HERALD_TRUST_PROXY_HOPS` | — | 프록시 홉이 둘 이상일 때만 |
| `HERALD_DEPLOYMENT_ORIGIN` | ✅ | `https://mantle-kr-herald.vercel.app` (새 프로젝트라면 §5에서 채웁니다) |
| `HERALD_SENDS_ENABLED` | — | 첫 배포에서는 **비워 둡니다** (§6) |

**`HERALD_STORAGE_MODE=cloud`도 기동 조건입니다.** 로컬에서 쓰던 `local`을 그대로 옮기면 발행이
로컬 타깃으로 풀려서, 승인 문서가 **함수의 임시 파일시스템**에 쓰입니다 — 업로드는 성공했다고
보고하고, 대시보드에는 게시된 행이 보이고, 인스턴스가 사라지면 링크가 전부 죽습니다. 아무도
실패를 알려주지 않는 종류라 `assertCloudStorage`가 기동 단계에서 거부합니다.

**`HERALD_TRUST_PROXY=true`는 선택이 아니라 기동 조건입니다.** Vercel Function에는 `pnpm serve`가
가진 것 같은 로 소켓이 없고, 클라이언트 연결을 실제로 끊는 것은 Vercel 엣지 네트워크입니다 —
이 함수에 도달하는 요청은 전부 엣지를 먼저 지나므로 `X-Forwarded-For`를 진실하게 세울 수 있는 것도
엣지뿐입니다. 이 값이 없으면 모든 요청이 "믿을 만한 주소 없음"으로 풀려 **주소별 로그인 잠금이 셀
키를 얻지 못하고**, 전역 50회 백스톱만 남습니다. 그 상태에서는 바깥의 한 사람이 팀 전체의 로그인을
조용히 막을 수 있습니다. 그래서 함수는 그 상태로 서비스하느니 **아예 뜨지 않기를 택합니다.**

### 위 표가 전부가 아닙니다 — `.env`에서 옮겨야 할 것들

위 표는 **없으면 함수가 안 뜨는** 변수들입니다. 그 밖에도 로컬 `.env`에 채워져 있는 값 중
옮기지 않으면 **조용히 기능이 빠지는** 것들이 있습니다. 안 옮겼을 때 어디서 어떻게 티가 나는지는
[`../env.md`](../env.md)에 정리해 뒀습니다.

| 묶음 | 변수 | 안 옮기면 |
|---|---|---|
| Google 인증·Drive | `GOOGLE_AUTH_MODE`, `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN`, `GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`, `GDRIVE_SENT_FOLDER_ID` | **google 발행 타깃이 조용히 사라집니다.** 에러 없음 — 버튼만 비활성 |
| Lark Drive | `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_WORKSPACE_URL`, `LARK_DRIVE_REVIEW_FOLDER_TOKEN`, `LARK_DRIVE_APPROVED_FOLDER_TOKEN`, `LARK_DRIVE_SENT_FOLDER_TOKEN` | 위와 같이 **lark 타깃이 조용히 사라집니다** |
| 발송 | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID_COMMUNITY`, `TELEGRAM_CHAT_ID_DEV`, `TYPEFULLY_API_KEY`, `TYPEFULLY_SOCIAL_SET_ID` | §6에서 발송을 열 때 실패합니다 |
| **`X_PREMIUM`** | 계정에 X Premium이 있으면 `true` | ⚠ **호스팅만 280자 제한을 겁니다.** 로컬에서 잘 나가던 롱폼이 첫 발송에서 거부됩니다 — 발행 쿼터가 월 15건이라 디버깅 비용이 실제 쿼터로 나갑니다 |
| 시트 | `GSHEET_ID`, `GSHEET_QA_ID` | 대시보드 헤더의 시트 링크가 사라집니다 |

**옮기면 안 되는 것:** `GOOGLE_SA_KEY_FILE`은 로컬 파일 경로라 함수에 그 파일이 없습니다.
수집 전용(`TWITTERAPI_IO_KEY`, `LARK_CHAT_IDS`, `REFERENCE_X_HANDLE`)은 배포본이 수집을 하지
않으므로 필요 없습니다 — 헤더 배지 호버 카드에 `키 없음`으로 보이는 게 전부입니다.

값이 이미 `.env`에 있다면 셸 히스토리에 남기지 않고 파일에서 바로 읽어 넣을 수 있습니다:

```bash
for k in X_PREMIUM GOOGLE_AUTH_MODE GDRIVE_REVIEW_FOLDER_ID …; do
  v=$(grep -m1 "^$k=" .env | cut -d= -f2-)
  [ -z "$v" ] && { echo "SKIP: $k"; continue; }
  printf '%s' "$v" | npx vercel env add "$k" production
done
```

### 배포 전에: `pnpm deploy:check`

위 두 표를 손으로 하나씩 대조하지 않아도 됩니다. `vercel env ls production --json`으로 등록된
변수 **이름**만 읽어(값은 절대 읽지 않습니다) 두 표를 그대로 검사하고, `vercel.json`의 리전이
프로젝트 설정과 같은지, `GOOGLE_SA_KEY_FILE`과 `HERALD_SENDS_ENABLED`가 없는지, 그리고
`pnpm doctor --live`로 로컬 자격 증명까지 확인합니다.

Vercel 쪽을 보기 전에 **로컬 저장소 상태**도 같이 봅니다 — `main` 브랜치인지, 커밋되지 않은
변경이 없는지, `origin/main`과 앞뒤로 차이가 없는지, 그리고 (`--skip-tests`가 없으면) `pnpm
test`가 통과하는지. **`npx vercel deploy --prod`는 커밋이 아니라 지금 작업 디렉터리를 그대로
올립니다** — 그래서 이 저장소 상태 자체가 검사 대상입니다. 커밋되지 않았거나 아직 push하지 않은
변경은 이 명령을 돌린 사람의 화면에는 있어도 다음에 `git pull`하는 사람 눈에는 안 보이는 채로
배포될 수 있습니다.

```bash
pnpm deploy:check
```

**기동을 막는 변수(위 필수 표의 여덟 개)가 하나라도 빠지면 경고가 아니라 거부합니다** — 종료
코드 1로 끝나 배포를 진행하지 못합니다. 조용히 기능만 빠지는 나머지 변수들은 경고로 남아 배포를
막지는 않습니다. 저장소 상태 검사(브랜치·클린 여부·push/pull 동기화)와 테스트 실패도 같은
방식으로 거부합니다 — 경고가 아니라 종료 코드 1입니다. 이미 테스트를 통과시킨 상태에서 Vercel
변수만 고쳐 다시 돌릴 때는 `--skip-tests`로 그 단계만 건너뜁니다. **배포하기 전에는 항상 이
명령을 먼저 돌리세요.**

## 5. 배포하고 오리진을 되먹이기

`HERALD_DEPLOYMENT_ORIGIN`에는 닭-달걀 문제가 있습니다. 기본 `*.vercel.app` 도메인을 쓰기로 했으므로
**배포하기 전에는 이 배포의 오리진이 존재하지 않습니다.** 그래서 순서가 이렇습니다.

1. 나머지 변수를 채운 상태로 한 번 배포한다
2. 배포된 주소를 확인한다 (`https://<프로젝트>.vercel.app`)
3. 그 값을 `HERALD_DEPLOYMENT_ORIGIN`에 넣는다 — **스킴 + 호스트만, 경로 없이**
4. 다시 배포한다

현재 배포에서는 이 과정이 이미 끝나 있고 값은 `https://mantle-kr-herald.vercel.app`입니다. 위
순서는 프로젝트를 새로 만들거나 도메인을 바꿀 때 다시 필요합니다. **끝에 `/`를 붙이지 마세요** —
경로가 붙은 값은 오리진과 정확히 일치하지 않아 상태 변경 요청이 전부 거부됩니다.

이 값은 CSRF 방어(`refusalReason`, 로컬의 루프백 검사와 같은 코드)가 쓰며, Origin이 이것과 정확히
일치하지 않는 상태 변경 요청을 전부 거부합니다. **절대 추론하거나 관대한 기본값으로 두지 않습니다** —
설정이 없다고 조용히 전부 통과시키는 허용목록은 허용목록이 없는 것보다 나쁩니다.

### 배포 전 리허설

```bash
pnpm build:web
pnpm serve:hosted
```

호스팅에서 실제로 뜨는 화면 그대로입니다 — `[변환 준비]`가 없고, 발송이 닫혀 있습니다. 프리뷰
배포를 꺼 두었으므로 **프로덕션 전에 호스팅 화면을 보는 방법은 이것뿐입니다.**

## 6. 발송 열기 (나중에)

첫 배포는 발송이 닫힌 상태입니다. `HERALD_SENDS_ENABLED`를 설정하지 않으면(또는 문자열 `true`가
아니면) 실제 텔레그램 방이나 브랜드 X 계정에 닿는 유일한 라우트가 닫힙니다.

팀이 승인 흐름을 충분히 신뢰하게 되면 `HERALD_SENDS_ENABLED=true`로 바꾸고 재배포합니다 —
**새 코드가 아니라 변수 하나입니다.** 화면의 `발송`/`재발송` 버튼도 이 플래그를 따라 잠기고 풀리므로,
닫힌 상태에서 눌러 놓고 나간 줄 아는 일은 생기지 않습니다.

`pnpm serve`는 이 플래그를 읽지 않습니다 — 로컬은 예나 지금이나 항상 발송합니다.

실제로 열 때의 명령과 첫 발송 체크리스트는 [`deploy.md`의 "발송 열기"](../deploy.md#발송-열기)에
있습니다.

## 7. 호스팅으로 옮기지 않은 것

| 하는 일 | 어디서 | 왜 |
|---|---|---|
| `[변환 준비]` (에이전트 인계) | 로컬 CLI만 | 워크시트를 채우는 것은 운영자 머신의 로컬 에이전트입니다. 호스팅 엔트리포인트는 이 라우트를 **등록하지 않습니다.** 요청 큐 방식은 보류했습니다 |
| `pnpm send:reconcile` (2분 주기) | 로컬 크론 | Vercel Hobby 플랜의 크론 상한이 하루 한 번입니다 |
| 수집·번역·변환·발행 CLI | 로컬 CLI | 호스팅 대시보드는 검수·승인·발송 화면입니다 |

## 검증

화면을 손으로 눌러보는 대신 배포된 주소에 `pnpm deploy:smoke`를 돌립니다. 대시보드 아이디·
비밀번호를 프롬프트로 물어보므로(셸 히스토리에 남지 않습니다) 그 자리에서 입력합니다:

```bash
pnpm deploy:smoke https://mantle-kr-herald.vercel.app
```

로그인하기 전에는 `GET /`이 **200**으로 SPA를 서빙하는지, 인증 없이 부른 `/api/status`가
**401**을, 다른 오리진에서 시도한 로그인이 **403**을 돌려주는지부터 봅니다 — 403이 아니면
CSRF 방어가 낯선 오리진을 걸러내지 못하고 있다는 뜻입니다.

로그인에 성공하면 이어서 `/api/status`가 다음을 보고하는지 확인합니다 — 각 항목이 뜻하는 바:

- `storageMode`가 `cloud`인가 — 아니면 승인 문서가 함수의 임시 파일시스템에 쓰이고 있다는
  뜻입니다(§4)
- `dbEnv`가 `production`인가 — 아니면 이 배포가 운영이 아닌 데이터베이스를 보고 있다는
  뜻입니다
- `sendsEnabled`가 `false`인가 — 첫 배포는 발송이 닫힌 채로 나가야 합니다(§6)
- `conversionEnabled`가 `false`인가 — 호스팅 라우트 세트에는 로컬 변환 에이전트가 없습니다
  (§7)
- `availableTargets`에 `google`이 있는가 — 없으면 §4의 Google 인증·Drive 변수가 빠진 것입니다
- 응답의 `integrations` 중 **Google Drive**가 `configured`인가 — 클라우드 모드의 진실
  공급원이라 이것만 실패로 잡습니다. 나머지(수집 전용 키, Lark Drive, Telegram, Typefully,
  Google Sheets, 로컬 폴더)는 설정돼 있지 않아도 경고로만 남습니다 — 수집 전용 키는 애초에
  §4에서 호스팅에 옮기지 말라고 안내한 것들입니다

이어서 `POST /api/items/:id/convert-prepare`가 거부가 아니라 **404**인지(라우트가 아예 없어야
합니다) 확인하고, 마지막으로 `POST /api/logout`이 **200**을 돌려주는지, 그리고 응답의
`Set-Cookie`가 세션 쿠키를 실제로 지우는지 확인합니다. 토큰 자체는 서버에서 폐기되지
않으므로(로그아웃 전에 복사해 둔 쿠키를 그대로 재전송하면 여전히 통합니다) 로그아웃 뒤
`/api/status`를 다시 불러 401을 기대하는 것은 이미 위에서 확인한 인증 없는 호출과 같은
호출이 되어 아무것도 새로 증명하지 못합니다 — 그래서 로그아웃 응답 자체의 두 가지만 봅니다.

> **`GET /`이 200이라고 배포가 산 게 아닙니다.** 정적 SPA는 Vercel이 직접 서빙하므로 함수가
> 완전히 죽어도 화면은 뜹니다. `--lockout` 옵션의 주의사항, 두 명령이 확인하지 못하는 것(배포된
> Google 토큰의 생존), 그리고 API를 직접 찔러 보는 방법은
> [`deploy.md`의 "검증"](../deploy.md#검증)에 있습니다.

## 자주 겪는 실패

| 증상 | 원인 |
|---|---|
| 함수가 아예 뜨지 않고 trust-proxy 관련 오류 | `HERALD_TRUST_PROXY=true` 누락 (§4). 선택 변수가 아닙니다 |
| 로그인은 되는데 승인·발송이 전부 거부됨 | `HERALD_DEPLOYMENT_ORIGIN`이 비었거나 실제 주소와 다릅니다. 스킴·호스트가 정확히 일치해야 합니다 |
| 팀원 한 명의 오타로 전원이 로그인 불가 | 프록시 뒤인데 trust-proxy가 꺼져 모두가 잠금 행 하나를 공유하는 상태입니다 |
| 화면은 뜨는데 항목이 하나도 없음 | 데이터베이스가 비었거나 `HERALD_DB_ENV`가 개발 쪽을 가리킵니다. `pnpm db:import` 확인 |
| `relation "x_threads" does not exist` | 스키마 미적용. `pnpm db:import`를 한 번 돌리세요 (§2) |
| 환경변수는 다 맞는데 `pnpm deploy:check`가 종료 코드 1을 냄 | `main`이 아니거나, 커밋 안 된 변경이 있거나, `origin/main`과 앞뒤로 차이가 있는 상태입니다(§4). `vercel deploy --prod`는 작업 디렉터리를 그대로 올리므로 이것도 거부 대상입니다 |

배포 자체가 실패하거나, 올라갔는데 `/api/*`가 500 또는 404를 내는 경우는 이 표에 없습니다 —
셋 다 **업로드된 뒤에만 존재하는** 문제라 [`deploy.md`의 "배포 전에는 안 보이는
함정"](../deploy.md#배포-전에는-안-보이는-함정)에 따로 정리해 뒀습니다.

## 다음으로

- **배포 뒤의 모든 것** (재배포·비밀번호 교체·발송 열기·롤백) → [`deploy.md`](../deploy.md)
- 주간 운영 루틴·사고 대응 → [`team-runbook.md`](../team-runbook.md)
- 검수자에게 안내할 내용 → [`review.md`](../review.md)
- 명령별 입출력·저장 모드 → [`artifacts.md`](../artifacts.md)
