# 배포 운영 가이드 (deploy.md)

호스팅 대시보드가 **이미 올라간 뒤**로 계속 보는 문서입니다. 재배포, 자격증명 교체, 발송 열기,
롤백, 그리고 "배포가 정말 살아 있는지" 확인하는 법.

처음 한 번 세우는 절차는 [`setup/vercel.md`](setup/vercel.md)에 있습니다. 이 파일 맨 아래
[최초 구축 기록](#최초-구축-기록)에는 2026-08-02~05에 실제로 어떻게 세웠는지가 접혀 있습니다 —
재구축하거나 두 번째 환경을 만들 때만 펴 보세요.

---

## 현재 상태

| | |
| --- | --- |
| 주소 | https://mantle-kr-herald.vercel.app |
| 호스팅 | Vercel Function (`sin1`, 싱가포르) + 정적 SPA |
| 데이터베이스 | Neon Postgres, `ap-southeast-1` — Vercel Marketplace 통합이 `DATABASE_URL` 주입 |
| 배포 방식 | `npx vercel deploy --prod` — **로컬 디렉터리를 직접 업로드.** git 푸시로는 배포되지 않습니다 |
| 발송 | **닫힘** (`HERALD_SENDS_ENABLED` 미설정) |
| 계정 | 팀 공용 하나 (`HERALD_AUTH_USERNAME` / `HERALD_AUTH_PASSWORD_HASH`) |

---

## 지켜야 할 것 네 가지

1. **테스트 발송 금지.** Typefully 발행 쿼터는 월 15건이고 그게 진짜 상한입니다. 진짜 나갈
   딜리버러블이 생길 때까지 기다렸다가 그걸로 첫 발송을 합니다.
2. **`HERALD_SENDS_ENABLED`는 함부로 켜지 않습니다.** 1차·2차 승인이 자리잡은 뒤 변수 하나만
   바꿔서 엽니다 ([발송 열기](#발송-열기)).
3. **`.env`는 건드리지 않습니다.** 리허설·드라이런은 별도 env 파일을 만들어 `--env-file`로
   주입합니다. 2026-08-09부터 이 규칙은 규율이 아니라 장치입니다 — 스케줄러는 `.env`를 링크로
   보지 않고 배포 시점 사본으로 봅니다. 그래도 다음 `bash deploy/herald-deploy.sh`가 지금 `.env`를
   프로덕션으로 옮기므로, 실험을 남겨둔 채 배포하면 게이트가 이름을 보여주고 멈춥니다.
4. **환경변수를 바꿨으면 재배포해야 반영됩니다.** Vercel은 배포 시점의 값을 함수에 굽습니다.

---

## 반복 작업

### 재배포

**언제 돌리나 — 대시보드에 보이는 것이 달라지는 머지를 한 직후입니다.** `web/` 변경, 검수 화면
문구, API 라우트, 그리고 환경변수를 바꿨을 때(Vercel은 배포 시점의 값을 함수에 굽습니다).
`bash deploy/herald-deploy.sh`는 **스케줄러만** 갱신하므로 이걸 대신해 주지 않고, git 푸시로도
배포되지 않습니다 — 둘 다 필요한 머지가 흔합니다
([team-runbook](team-runbook.md)의 "배포 체크아웃" 절 참고).

```bash
pnpm deploy:check                                   # 통과해야 배포
npx vercel deploy --prod
pnpm deploy:smoke https://mantle-kr-herald.vercel.app
```

`deploy:check`가 로컬 개발 DB 연결로 거부하면(`pnpm doctor --live` 실패) 프로덕션 문제가 아니라
로컬 컨테이너가 내려간 것입니다 — `docker start herald-db`로 올리고 다시 돌리세요. 게이트를
`--skip-tests`로 우회하지 마세요, 그 플래그는 테스트만 건너뜁니다.

`deploy:smoke`는 배포본에 **실제로 로그인해서** 확인합니다. 기본은 아이디·비밀번호를 물어보지만,
환경변수로 주면 묻지 않습니다 — CI나 스크립트에서 돌릴 때 쓰세요:

```bash
HERALD_SMOKE_USERNAME=... HERALD_SMOKE_PASSWORD=... \
  pnpm deploy:smoke https://mantle-kr-herald.vercel.app
```

**둘 다 주거나 둘 다 안 주거나** 해야 합니다. 하나만 주면 나머지를 묻지 않고 **거절합니다** —
tty 없는 러너에서 프롬프트가 뜨면 잡이 타임아웃날 때까지 멈춰 있고, 그건 "시크릿 하나 빠짐"이
아니라 "배포가 망가짐"처럼 보이기 때문입니다. 참고로 여기 넣는 건 **비밀번호 원문**입니다
(서버 쪽 `HERALD_AUTH_PASSWORD_HASH`와 달리 이건 클라이언트 쪽입니다).

`deploy:check`는 **로컬 디렉터리가 곧 배포본**이라는 사실 위에 서 있습니다 — `main` 여부,
워킹 트리 청결, `origin/main`과의 동기화, `pnpm test`, Vercel 프로젝트의 환경변수 이름 28개,
금지 변수 2개 부재, 리전 일치, 도메인. `--skip-tests`는 환경변수만 고치고 재시도할 때 씁니다.

### 자격증명 교체 (비밀번호)

> **해시를 셸에 노출하지 마세요.** 해시는 `scrypt$65536$8$1$…` 꼴이라, 큰따옴표 안에서
> `$8`·`$1`이 빈 문자열로 확장됩니다. `--value "scrypt$…"`로 넣으면 그 자리에서 망가집니다.
> 아래처럼 **stdin으로** 넣으세요.

```bash
pnpm auth:hash > ~/herald-hash.txt      # 프롬프트는 stderr라 화면에 보입니다
                                        # 아이디는 엔터로 넘기세요 — 해시와 무관합니다
npx vercel env rm HERALD_AUTH_PASSWORD_HASH production -y
grep '^HERALD_AUTH_PASSWORD_HASH=' ~/herald-hash.txt | cut -d= -f2- | tr -d '\n' \
  | npx vercel env add HERALD_AUTH_PASSWORD_HASH production --sensitive -y
npx vercel deploy --prod
rm ~/herald-hash.txt
```

넣기 전에 형태를 확인하세요 — `$`로 나눴을 때 **6조각**, 첫 조각이 `scrypt`여야 합니다.
망가진 해시를 넣으면 이제 **함수가 기동을 거부**하고 이유를 말합니다(예전에는 조용히 기동해서
모든 로그인을 401로 거부했습니다).

**아이디만 바꿀 때는 해시를 다시 만들 필요가 없습니다.** 아이디는 해시에 들어가지 않고, 로그인은
둘을 각각 상수시간 비교합니다(`src/domain/auth/credentials.ts`). `HERALD_AUTH_USERNAME`만
갈고 재배포하세요.

### 발송 열기

**진짜 나갈 딜리버러블이 준비된 뒤에** 합니다.

```bash
printf 'true' | npx vercel env add HERALD_SENDS_ENABLED production -y
npx vercel deploy --prod
```

- [ ] 보드에서 `발송 · 잠김`이 `발송`으로 바뀐 것 확인
- [ ] **딱 1건** 발송하고 지켜보기
- [ ] 방에 실제로 도착했는지 확인
- [ ] 대시보드에 발송 이력 행이 생겼는지 확인
- [ ] 로컬에서 `pnpm send:reconcile` → 같은 행에 x.com URL이 붙는지 확인

되돌릴 때: `npx vercel env rm HERALD_SENDS_ENABLED production -y` 후 다시 `deploy --prod`.

### Google OAuth 토큰이 7일마다 죽을 때

**증상:** 일주일쯤 지나면 Drive 업로드·Sheet 기록이 조용히 실패하고, `pnpm doctor --live`가
`invalid_grant / Token has been expired or revoked`를 냅니다.

원인은 설정 하나입니다. Google 문서 원문:

> A Google Cloud Platform project with an OAuth consent screen configured for an external user type
> and a publishing status of "Testing" is issued a refresh token expiring in 7 days

우리 앱이 정확히 그 조건입니다 — External + Testing + `drive.file`·`spreadsheets` 스코프.
**게시 상태를 "In production"으로 바꾸면 그 조건에서 벗어납니다.**

`gcloud`에는 이 설정을 바꾸는 명령이 없습니다(확인함 — `alpha iap oauth-brands`는 IAP 전용이고
폐기 예정, `auth-platform` 계열은 존재하지 않음). 콘솔 작업입니다:

1. https://console.cloud.google.com/auth/audience → **PUBLISH APP**
2. **게시 후 `pnpm google:auth`를 다시 돌리세요.** 지금 토큰은 Testing일 때 발급된 것이라 자기
   7일 시계를 그대로 들고 있습니다
3. **`GOOGLE_OAUTH_CLIENT_ID`·`_SECRET`·`_REFRESH_TOKEN` 세 개를 한 벌로** `.env`와 Vercel 양쪽에
   갱신한 뒤 재배포
4. `pnpm deploy:smoke <배포 주소>`로 확인 — `live: google_auth`가 초록불인지

> **refresh token만 옮기면 안 됩니다.** 토큰은 그것을 발급한 OAuth 클라이언트에 묶여 있어서,
> 새 토큰을 낡은 `CLIENT_ID`/`_SECRET`과 짝지으면 인증이 깨집니다. 2026-08-10에 실제로 이
> 문단의 옛 지시("refresh token을 두 곳 모두 갱신")를 그대로 따라 그렇게 됐습니다.
>
> 증상으로 구분됩니다 — **`400 invalid_grant`**는 토큰이 폐기·만료된 것이고,
> **`401`**은 클라이언트 자격증명이 안 맞는 것입니다. 401을 보고 토큰을 다시 발급하면
> 같은 자리를 맴돌게 됩니다.
>
> 그리고 4번이 `pnpm doctor --live`였을 때는 이 실패를 **잡을 수 없었습니다.** doctor는 로컬
> 토큰을 검사하는데 로컬은 멀쩡했으니까요. 배포본의 크레덴셜이 살아 있는지는 `deploy:smoke`의
> `live:` 줄만 압니다(2026-08-10에 추가).

`spreadsheets`가 민감 스코프라 검증을 안 받으면 재인증 때 **"Google hasn't verified this app"**
경고가 뜨고, **신규 사용자 100명 상한**이 프로젝트 수명 전체에 걸립니다(리셋 불가). 우리는 팀
공용 Google 계정 하나만 인증하므로 무관하고, 대시보드 로그인 인원과도 관계없습니다 — 그쪽은
Google을 거치지 않습니다.

### 롤백

```bash
pnpm db:export --yes    # 데이터베이스 → output/
# 코드는 이전 커밋으로 되돌린 뒤
pnpm serve              # 다시 로컬로 동작
```

내보내기 자체가 의심스러우면 `pnpm state:pull`로 Drive 스냅샷을 복구합니다.

Vercel 쪽만 되돌리려면 이전 배포로 승격하면 됩니다 — `npx vercel ls mantle-kr-herald`로 목록을
보고 `npx vercel promote <배포-URL>`.

---

## 검증

### `GET /`로는 배포가 살았는지 알 수 없습니다

정적 SPA는 **Vercel이 직접 서빙**합니다. 함수가 완전히 죽어도 `GET /`은 200을 돌려주고 보드
화면까지 뜹니다. 2026-08-05에 두 번 그랬습니다. 반드시 API를 직접 찌르세요:

```bash
for p in /api/status /api/publish/state /api/outlets/x:1/announcement/tg-dev; do
  printf "%-46s → %s\n" "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' "https://mantle-kr-herald.vercel.app$p")"
done
# 셋 다 401 이어야 정상. 404가 하나라도 나오면 라우팅이 깨진 것,
# 500이면 함수가 기동에 실패한 것 → npx vercel logs <url>
```

한 세그먼트(`/api/status`)만 401이고 깊은 경로가 404라면 [함정 ②](#-api-경로가-두-세그먼트부터-404)입니다.

### `pnpm deploy:smoke <url>`

로그인까지 포함한 전체 확인입니다. **비밀번호를 프롬프트로 받으므로 사람이 직접 실행합니다.**

정상이면 `28 ok · 2 warn · 0 fail`. warn 2개는 둘 다 의도된 것입니다 —
`TWITTERAPI_IO_KEY` 미등록(등록하지 않았다면 대시보드의 `링크 수집` 탭만 잠깁니다 — 나머지 기능은
그대로 동작하므로 배포 자체를 막는 것은 아닙니다)과 `--lockout` 건너뜀.

확인하는 것: 익명 401 · 외부 Origin 403 · 로그인 200 · `storageMode: cloud` ·
`dbEnv: production` · `sendsEnabled: false` · `conversionEnabled: false` · google/lark 타깃 ·
통합별 configured · **자격 증명 7개가 실제로 살아 있는지(`live:` 줄)** · `convert-prepare` 404 ·
로그아웃이 세션 쿠키 삭제.

`live:` 줄 7개(`google_auth` · `google_drive_review` · `google_drive_approved` ·
`google_sheets` · `lark` · `typefully` · `telegram`)가 곧 아래 "두 명령이 못 보던 것"의 답입니다.
등급은 그 자격 증명이 **무엇에 쓰이는지**로 갈립니다 — 발행용(Google 인증·Drive 두 폴더·Lark)이
죽으면 **fail**, 발송용(Typefully·Telegram)은 `sendsEnabled`가 열려 있을 때만 fail(닫혀 있으면
warn), Sheet는 헤더 링크뿐이라 언제나 warn. **미설정(`skipped`)은 fail도 warn도 아닙니다** —
존재 여부는 `deploy:check`의 몫이고, Telegram만 쓰는 설치가 Lark가 없다고 빨개지면 안 됩니다.

**이 표를 읽는 곳은 이제 셋입니다** — `deploy:smoke`의 `live:` 줄, `pnpm creds:check`의 텔레그램
알림, 그리고 **대시보드 헤더의 배지**. 표 자체는 `src/doctor/liveSeverity.ts` 한 곳에만 있고,
터미널용 채점기(`src/deploy/smokeChecks.ts`)와 보드용 채점기(`src/status/liveness.ts`의
`summarizeLiveness`)가 거기서 같은 걸 가져다 씁니다 — 판정은 서버에서 끝나고, 화면 쪽은 색과 문구만
고르지 등급을 다시 계산하지 않습니다. 게다가 보드는 **같은 관측을 읽습니다**: 이 라우트(`GET
/api/diagnostics/live`)가 찔러본 직후 자기가 본 걸 `credential_liveness` 한 행에 기록하고, 보드는
그 행을 읽을 뿐 다시 확인하지 않습니다. 그래서 여기서 fail인 자격 증명이 보드에서 warn으로 보이는
일은 있을 수 없고, 방금 이 명령이 본 결과가 그대로 헤더에 뜹니다
([`env.md`](env.md) §7의 "같은 카드의 `키 응답`").

> **`live:` 줄이 하나도 없고 `credential liveness`가 fail이면** 배포본이 `GET
> /api/diagnostics/live`를 모르는 옛 버전이거나, 라우트가 에러를 답한 것입니다. detail에 실제 HTTP
> 코드가 찍히니 그것부터 보세요 — 401이면 배포본이 아니라 `deploy:smoke`가 세션을 안 보낸 것이고,
> 그건 2026-08-10에 실제로 있었던 버그입니다(`tests/deploy/smokeSession.test.ts`가 막습니다).
> 보고서가 **비어 있거나 7개가 안 되어도** fail입니다. 아무도 묻지 않은 자격 증명은 살아 있다고
> 확인된 자격 증명이 아닙니다.

> **로그인 401이 나오면** 아이디·비밀번호가 틀린 것입니다. 배포 문제가 아닙니다. 빈 값·한 글자·
> 틀린 12자가 **전부 같은 401**이라 화면만 봐서는 구분되지 않습니다. 그리고 **IP당 5회 실패면
> 60초 잠깁니다**(그때는 429).

### 두 명령이 못 보던 것 — 이제 `deploy:smoke`가 봅니다

**배포본의 Google 리프레시 토큰이 살아 있는지를 둘 다 몰랐습니다.** 앱이 존재 여부만 보기
때문입니다 — `createDeps`가 Google 설정을 try/catch로 확인하고 던지면 타깃을 빼는데, 폐기된
토큰도 설정은 멀쩡해 보입니다. 2026-08-04에 실제로 한 시간 동안 그 상태였습니다
(`doctor`는 `✓ Google Drive configured`, 모든 refresh는 `invalid_grant`). 2026-08-10에는
`deploy:check`도 `deploy:smoke`도 초록이었는데 배포본의 토큰은 이미 몇 분 전에 죽어 있었습니다.

**`deploy:smoke`가 이제 그 자리를 메웁니다.** 살아 있는지는 자격 증명이 있는 곳 — 배포본 안 —
에서만 보이므로, 배포본이 세션 뒤의 `GET /api/diagnostics/live`에서 직접 호출해 보고 그 결과를
돌려줍니다(`src/doctor/liveProbes.ts`, `pnpm doctor --live`와 **같은 코드**). 전체 호출에
5초 예산이 하나 걸려 있어서, 외부 API가 멈춰 있어도 라우트는 5초 안에 답합니다.

**그래도 남는 것 두 가지.** ① `deploy:check`가 확인하는 건 여전히 **로컬** 토큰입니다 — 토큰
교체는 항상 두 곳입니다. ② `deploy:smoke`는 **배포 시점**만 봅니다. 2026-08-10처럼 배포와 배포
**사이**에 죽는 건 다음 배포 때까지 아무도 모릅니다 — **이제 `pnpm creds:check`와 그걸 매일
06:23에 돌리는 `herald-creds.timer`가 그 자리를 맡습니다**(설치와 등급표는
[`team-runbook.md`](team-runbook.md)의 "크레덴셜 상시 점검"). 같은 `live:` 판정을 쓰지만 배포
파이프라인이 아니라 타이머에서 돌고, 발행 크레덴셜이 죽어 있으면 텔레그램으로 알립니다.

**그리고 그 답이 이제 화면에도 남습니다.** 두 명령의 결과는 터미널과, 이 컴퓨터가 8분마다
갈아치우는 journal에만 있었습니다 — 정작 팀이 하루 종일 보는 화면은 아무 말도 안 했고,
2026-08-10에 나흘 동안 그랬습니다. 이제 대시보드 헤더의 배지가 위에서 기록된 그 행을 읽어서, 죽은
키가 있으면 알약 옆에 ⚠ 칩을 띄웁니다. **26시간 넘게 아무도 안 찔러봤으면 그것도 노랑으로
뜹니다** — 이 컴퓨터가 꺼져 있으면 실패하는 유닛이 없어서 `OnFailure=` 알림도 안 오고, 그 침묵이
보이는 곳은 보드뿐이기 때문입니다([`env.md`](env.md) §7). 기존 설치는 `pnpm db:migrate`가 한 번
돌아야 새 표(`credential_liveness`)가 생깁니다 — `deploy/herald-deploy.sh`가 배포마다 돌리니
스케줄러 쪽은 자동입니다.

---

## 배포 전에는 안 보이는 함정

2026-08-05 첫 배포가 세 번 만에 살았습니다. 셋 다 `pnpm test`·`pnpm typecheck`·`deploy:check`가
전부 초록인 상태에서 일어났습니다 — 그 셋은 **워킹 트리**를 보고, 이 문제들은 **업로드된 뒤**에만
존재하기 때문입니다.

> ### 배포 전에 `npx vercel build`를 돌리세요
>
> 같은 빌더가 로컬에서 돌면서 실제 라우팅 표를 `.vercel/output/config.json`에 써주고, 함수에
> 무엇이 들어갔는지도 `.vercel/output/functions/`에서 볼 수 있습니다. ②는 배포하지 않고도
> 그 파일에서 보였고, ①도 같은 산출물에서 확인됐습니다.
>
> `vercel build`는 `vercel pull`을 요구합니다. `--environment=development`로 받으세요
> (프로덕션 DSN이 development에 붙어 있지 않아 노출이 최소입니다). 끝나면
> `.vercel/.env.*.local`을 지우세요 — 아래 "로컬 `.env*`가 프로덕션 값을 가립니다"와 같은 파일입니다.

### ① 함수가 번들되지 않아 모든 `/api/*`가 500

```
ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/src/adapters/db/createDb'
```

`package.json`이 `"type": "module"`이라 `@vercel/node`는 "이미 ESM"으로 보고 CJS 변환을
건너뜁니다. 파일별로 트랜스파일하고 `@vercel/nft`로 추적할 뿐, **import 스펙파이어를 다시 쓰지
않습니다.** 이 레포는 상대 import에 확장자를 안 쓰는데(1015개), Node의 ESM 리졸버는 확장자가
없으면 못 찾습니다. 로컬에서는 `tsx`가 대신 풀어주고 있었을 뿐입니다.

**해결:** `pnpm build:api`가 `src/vercel/entry.ts`를 esbuild로 번들하고,
`api/[...path].ts`는 그 번들을 **확장자를 붙여** 재export하는 두 줄짜리 파일입니다.
`tests/deploy/functionBundle.test.ts`가 지킵니다.

### ② `/api` 경로가 두 세그먼트부터 404

`api/[...path].ts`는 캐치올처럼 생겼지만 Vercel zero-config는 `[...name]`을 그렇게 읽지
않습니다 — `...path`라는 이름의 **단일 동적 세그먼트**로 봅니다. 생성된 표가 그대로 말해줍니다:

```json
{ "src": "^/api/([^/]+)$", "dest": "/api/[...path]?...path=$1" }   ← 한 세그먼트만
{ "src": "^/api(/.*)?$",   "status": 404 }                        ← 나머지 전부
```

SPA는 `/api/outlets/:id/:type/:outletId`까지 부르므로 보드 대부분이 죽습니다. 그런데
**깨져 보이지 않습니다** — SPA는 엣지 404와 빈 보드를 구분하지 못해서 `해당하는 항목이 없습니다.`만
보여줍니다.

**해결:** `vercel.json`의 `rewrites`. `tests/deploy/apiRouting.test.ts`가
`web/src/api.ts`에서 경로를 직접 뽑아 검사합니다.

### ③ `.vercelignore` 패턴이 앵커 없이 모든 깊이를 지움

gitignore 문법에서 앞에 `/`가 없는 `translation/`은 **모든 깊이**에서 매칭돼
`src/domain/translation/`까지 제외합니다.

**해결:** 디렉터리 패턴은 전부 `/`로 시작합니다(`node_modules/` 하나만 예외).
`tests/deploy/vercelignore.test.ts`가 지킵니다 — 필요한 파일이 살아남는지, 자격증명과 `output/`이
확실히 빠지는지 둘 다.

> `.vercelignore`가 존재하는 이유 자체가 안전입니다. `vercel deploy --prod`는 **로컬 디렉터리를**
> 올리고, 이 트리에는 `keys/mantle-sa.json`(서비스 계정 개인키)과 `.env`가 있습니다. 둘 다
> gitignore돼서 `git status`에는 안 보입니다.

### ⚠ 로컬 `.env*`가 프로덕션 값을 가립니다

`vercel env run`은 내려받은 프로덕션 변수 **위에** 실행 디렉터리의 `.env.local` → `.env`를
덮어씌웁니다. 로컬 파일이 이깁니다:

| 실행 위치 | 나온 `DATABASE_URL` |
| --- | --- |
| 레포 루트 (`.env`만) | `127.0.0.1` — 로컬 도커 |
| `.env*` 없는 디렉터리 | 진짜 프로덕션 ✅ |

가리는 건 **파일에 무엇이 들었느냐가 아니라 파일이 있느냐**입니다. `.env.local`이 존재하면 그 안에
있는 키는 무엇이든 내려받은 프로덕션 값을 이깁니다. 2026-08-10에 이 표에는 "`.env.local` 있을 때 →
이미 없어진 옛 Neon"이라는 행이 하나 더 있었는데, 그때 그 파일이 죽은 `DATABASE_URL`을 들고 있었기
때문입니다. 지금은 그 파일이 없으니 행도 지웠습니다 — **경고가 낡은 게 아니라 방아쇠가 치워진
것**이고, `vercel link`나 `vercel dev`가 파일을 다시 만드는 순간 되살아납니다.

`.env`는 지킬 규칙 3이라 못 지웁니다. 그래서 **레포 안에서 `vercel env run -e production`은 영영
프로덕션 값을 못 줍니다.** 레포 밖 디렉터리에 `.vercel/`만 복사해 두고 `--cwd`로 가리키세요.
조용히 틀린 DB에 붙는 종류의 함정이라, 눈으로 호스트를 확인하기 전에는 파괴적인 명령을 돌리지
마세요.

`vercel env pull`은 바로 그 가리는 파일을 만드는 명령이라 쓰지 않습니다. `vercel link`와
`vercel dev`는 `VERCEL_OIDC_TOKEN`만 든 `.env.local`을 만드는데, 이 레포는 그 변수를 읽는 곳이
없습니다. 생겼으면 지우세요 — 쓰지도 않는 자격증명이 트리에 남는 데다, 위 함정의 방아쇠가
그 파일의 존재 자체입니다.

### `sensitive` 변수는 되읽을 수 없습니다

`HERALD_AUTH_PASSWORD_HASH`·`HERALD_SESSION_SECRET`·`TELEGRAM_BOT_TOKEN`은 `type=sensitive`라
`vercel env run`이 **빈 문자열**로 돌려줍니다. 값이 비었다는 뜻이 **아닙니다** — 가림입니다.
등록이 잘못됐는지 확인하려면 지우고 다시 넣는 수밖에 없습니다.

타입은 API로 볼 수 있습니다:

```bash
npx vercel api "/v9/projects/mantle-kr-herald/env?decrypt=false" \
  | python3 -c "import json,sys; [print(e['key'], e['type']) for e in json.load(sys.stdin)['envs']]"
```

---

## 누가 무엇을 하는가

에이전트에게 맡길 수 있는 것: 드라이런, 데이터 이관, 로컬 리허설, `deploy:check`,
배포 후 익명 확인, 로그 조사.

직접 하셔야 하는 것 — **대시보드가 필요해서가 아니라, 크레덴셜이나 되돌릴 수 없는 결과 때문입니다:**

| | 왜 |
| --- | --- |
| `pnpm auth:hash`, `openssl rand -hex 32` | 비밀번호·시크릿이 에이전트 세션에 남지 않게 |
| 시크릿 `env add` | 위와 같은 이유 |
| `pnpm deploy:smoke` | 로그인에 평문 비밀번호가 필요 |
| `vercel integration add neon` | 과금이 붙고 **리전이 영구 고정** |
| `vercel deploy --prod` | 실제 공개 |
| **첫 발송** | 쿼터 15건/월, 되돌릴 수 없음 |

---

## 최초 구축 기록

<details>
<summary>2026-08-02~05에 실제로 어떻게 세웠는지 — 재구축하거나 두 번째 환경을 만들 때만 펴 보세요</summary>

### 1. Vercel 프로젝트 링크

```bash
npx vercel login
npx vercel link          # 프로젝트 이름: mantle-kr-herald
```

`Connect detected Git repository?`가 실패해도 넘어갑니다. **이 설계에서는 Git 연결이 필요
없습니다** — `vercel.json`의 `git.deploymentEnabled: false`로 푸시 배포를 막아뒀고(프리뷰 배포
차단이 목적), 배포는 `vercel deploy --prod`가 로컬 디렉터리를 올려서 이뤄집니다.

프리뷰 배포가 정말 꺼져 있는지는 프로젝트의 `link`가 `null`인지로 확인합니다 — Git 저장소가 아예
연결돼 있지 않으면 푸시로 생기는 배포 자체가 존재하지 않습니다. `git.deploymentEnabled: false`보다
강한 상태입니다.

배포 주소는 대시보드 없이 API로 확인합니다:

```bash
npx vercel api "/v9/projects/mantle-kr-herald/domains"
```

→ `HERALD_DEPLOYMENT_ORIGIN=https://mantle-kr-herald.vercel.app` (scheme+host만, 끝 슬래시 없음)

`vercel link`가 만드는 `.env.local`은 커밋하지 않습니다 — 그리고 다 쓴 뒤에는 지우세요. 이유는
위 "로컬 `.env*`가 프로덕션 값을 가립니다"에 있습니다. 그리고 `.gitignore`에 추가되는 `.env*`
줄은 **제거해야 합니다** — 기존 `!.env.example` 예외를 마지막 규칙이 이겨서 `.env.example`이
무시돼 버립니다.

### 2. Neon 프로비저닝

**전부 CLI로 됩니다.** 서브커맨드는 `vercel install`이 아니라 `vercel integration add`입니다.

```bash
npx vercel integration add neon \
  --name mantle-kr-herald-db \
  -m region=sin1 -m auth=false \
  --plan free_v3 -e production
```

| 옵션 | 왜 |
| --- | --- |
| `-m region=sin1` | 싱가포르 — Neon에는 서울·도쿄가 없고 한국에서 가장 가깝습니다. Function도 같은 값. **리전은 생성 시점에만 정할 수 있고 나중에 못 바꿉니다** |
| `-m auth=false` | **기본값이 `true`.** Neon Auth를 켜는 옵션인데 우리는 팀 공용 계정 하나를 직접 구현해 뒀습니다. 안 끄면 쓰지도 않을 인증 스택이 딸려옵니다 |
| `--plan free_v3` | 나머지는 `launch_v3`, `scale_v3` |
| `-e production` | **production에만 연결.** 빼면 development에도 `DATABASE_URL`이 붙어서, `vercel env pull` 한 번에 개발 환경이 프로덕션 DB를 가리킵니다 |

옵션 목록은 CLI가 알려줍니다(TTY 필요):

```bash
script -qec 'stty cols 200; npx vercel integration add neon --help' /dev/null
```

리전은 **생성 직후 반드시 확인하세요.** 처음에 `us-east-1`로 만들어져서 지우고 다시 만들었습니다.

### 3. 환경변수 최초 등록

시크릿 둘만 프롬프트를 씁니다:

```bash
npx vercel env add HERALD_SESSION_SECRET      production --sensitive -y
npx vercel env add HERALD_AUTH_PASSWORD_HASH  production --sensitive -y
```

나머지는 시크릿이 아니므로 `--value`로 넘겨 프롬프트를 없앱니다:

```bash
npx vercel env add HERALD_AUTH_USERNAME      production -y --value 'mantle-kr'
npx vercel env add HERALD_DEPLOYMENT_ORIGIN  production -y --value 'https://mantle-kr-herald.vercel.app'
npx vercel env add HERALD_DB_ENV             production -y --value 'production'
npx vercel env add HERALD_STORAGE_MODE       production -y --value 'cloud'
npx vercel env add HERALD_TRUST_PROXY        production -y --value 'true'
```

**`-y`가 없으면 값을 넣은 뒤 확인 프롬프트에서 한 번 더 눌러야 합니다.** 아래 루프에서는 24번
물어봅니다.

`.env`에서 그대로 옮길 것들 — 값이 셸 히스토리에 남지 않도록 파일에서 읽습니다:

```bash
for k in TYPEFULLY_API_KEY TYPEFULLY_SOCIAL_SET_ID X_PREMIUM \
         TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID_COMMUNITY TELEGRAM_CHAT_ID_DEV \
         TWITTERAPI_IO_KEY \
         GOOGLE_AUTH_MODE \
         GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REFRESH_TOKEN \
         GDRIVE_APPROVED_FOLDER_ID GDRIVE_CONFIG_FOLDER_ID GDRIVE_PARENT_FOLDER_NAME \
         GDRIVE_REVIEW_FOLDER_ID GDRIVE_SENT_FOLDER_ID GDRIVE_SHARE_EMAILS GDRIVE_STATE_FOLDER_ID \
         LARK_APP_ID LARK_APP_SECRET LARK_WORKSPACE_URL \
         LARK_DRIVE_REVIEW_FOLDER_TOKEN LARK_DRIVE_APPROVED_FOLDER_TOKEN LARK_DRIVE_SENT_FOLDER_TOKEN \
         GSHEET_ID GSHEET_QA_ID; do
  v=$(grep -m1 "^$k=" .env | cut -d= -f2-)
  [ -z "$v" ] && { echo "SKIP(.env에 없음): $k"; continue; }
  printf '%s' "$v" | npx vercel env add "$k" production -y
done
```

옮기지 **않는** 것:

| 변수 | 왜 |
| --- | --- |
| `DATABASE_URL` | Neon 통합이 주입합니다. 직접 추가하지 마세요 |
| `GOOGLE_SA_KEY_FILE` | 로컬 파일 경로라 함수에는 그 파일이 없습니다 |
| `HERALD_SENDS_ENABLED` | 첫 배포는 발송이 닫힌 채로 |

늦게 발견해서 추가한 넷: `X_PREMIUM`(없으면 호스팅만 280자 제한이 걸려 롱폼이 발송에서 거부됨),
`LARK_*` 전체(없으면 `loadLarkDriveConfig()`가 던지고 lark 타깃이 조용히 빠져 발행 버튼만
비활성), `GOOGLE_AUTH_MODE`(추론으로도 동작하지만 명시), `TWITTERAPI_IO_KEY`(없어도 함수는 뜨고
나머지는 그대로 동작하지만, 대시보드의 `링크 수집` 탭만 잠깁니다 — `HERALD_TRUST_PROXY`류의
기동 조건과는 다릅니다. 자세한 내용은 [`setup/vercel.md`](setup/vercel.md)).

### 4. 실데이터 이관

> **⚠ 스키마는 함수가 만들지 않습니다.** `db:import`/`db:export`는 시작할 때 `applySchema`를
> 부르지만 Vercel 함수는 부르지 않습니다. `auth_attempts`(로그인 실패 카운터)도 거기서 만들어지는
> 테이블이라, **빈 DB에 그냥 배포하면 첫 로그인부터 `relation "auth_attempts" does not exist`로
> 깨집니다.** "URL 보려고 일단 배포"는 하지 마세요.

**4-0. `output/`을 DB의 거울로 다시 만들기 — 반드시 먼저.**
`db:import`가 읽는 건 DB가 아니라 `output/` 파일 트리인데, 그 트리는 자동으로 갱신되지 않습니다.
이관을 시작할 때 6일 낡은 상태였습니다.

**그리고 `db:export`만으로는 부족합니다.** export는 DB 행을 파일에 *기록만* 하고 대상 파일을
비우지 않습니다 — 결과는 `기존 파일 ∪ DB`이지 DB의 거울이 아닙니다. 12행짜리 DB를 12행짜리
파일에 export했더니 13행이 됐습니다(DB에서 사라진 유령 행이 부활). 그래서 **빈 디렉터리로
뽑아서 덮어씁니다**:

```bash
cp -rp output /tmp/output-backup
rm -rf /tmp/mirror && mkdir -p /tmp/mirror
pnpm db:export /tmp/mirror --yes
cd /tmp/mirror && find . -type f -exec cp {} <레포>/output/{} \;
```

`output/`에는 DB에 없는 작업 산출물(`review/`, `archive/`, `worksheets/`, 런 로그)도 있으니
**덮어쓰기만 하고 통째로 지우지 마세요.**

**4-1. 백업.** `pnpm state:push` — Drive에 올라간 폴더를 기록해 두세요. 이관 전 복구 지점입니다.

**4-2. 스크래치 DB로 드라이런.**

```bash
docker run -d --name herald-dryrun \
  -e POSTGRES_PASSWORD=dryrun -e POSTGRES_DB=herald -p 5433:5432 postgres:16-alpine

printf 'DATABASE_URL=postgres://postgres:dryrun@127.0.0.1:5433/herald\nHERALD_DB_ENV=development\n' > /tmp/dryrun.env
npx tsx --env-file=/tmp/dryrun.env src/cli/db-import.ts --yes
npx tsx --env-file=/tmp/dryrun.env src/cli/db-export.ts /tmp/herald-export-check --yes
diff -r output/ /tmp/herald-export-check/
```

**`Files ... differ` 줄이 하나도 없어야 합니다.** `Only in output/: ...` 줄은 정상입니다 —
`review/`·`archive/`·`worksheets/`처럼 DB가 뒷받침하지 않는 파일이라 export가 애초에 쓰지
않습니다. (예전 판정 기준이던 "diff가 아무것도 출력하지 않아야 한다"는 달성 불가능했습니다.)

파일 대조보다 강한 확인은 **DB 대 DB 체크섬**입니다. `ordinal`은 삽입 순서용 대리키라 소스에 빈
번호가 있으면 임포트 후 메워지므로(상대 순서는 보존) 그 컬럼은 빼고 비교합니다:

```bash
for t in x_threads lark_items translations variants renderings outlet_overrides \
         deliveries x_article_deliveries publish_entries lineage few_shot_examples; do
  cols=$(docker exec herald-db psql -U postgres -d herald -t -A -c \
    "select string_agg(column_name,',' order by ordinal_position) from information_schema.columns \
     where table_name='$t' and column_name <> 'ordinal'")
  for c in herald-db herald-dryrun; do
    docker exec $c psql -U postgres -d herald -t -A -c \
      "select md5(string_agg(x::text, E'\n' order by x::text)) from (select $cols from $t) x"
  done | uniq -c | grep -q '^ *2 ' && echo "✓ $t" || echo "✗ $t"
done
```

정리: `docker rm -f herald-dryrun`.

**4-3. 프로덕션 임포트.** DSN을 명령줄에 쓰지 않습니다. `DATABASE_URL`과 `HERALD_DB_ENV`만 담은
파일을 만들어 주입하면, 임포트가 Drive·텔레그램 자격증명에 손댈 수조차 없습니다:

```bash
pnpm status    # 이전 수치 기록

npx vercel env run --cwd <레포_밖_디렉터리> -e production -- node -e \
  'process.stdout.write("DATABASE_URL="+process.env.DATABASE_URL+"\nHERALD_DB_ENV=production\n")' \
  > /tmp/prod.env
chmod 600 /tmp/prod.env

npx tsx --env-file=/tmp/prod.env src/cli/db-import.ts          # 미리보기 — 프로덕션은 거부됩니다
npx tsx --env-file=/tmp/prod.env src/cli/db-import.ts --yes
```

첫 줄이 붙은 DB를 출력합니다. **리전이 맞는지 눈으로 확인하고 `--yes`를 붙이세요.** 끝나면
4-2의 체크섬 대조를 소스 ↔ 프로덕션으로 한 번 더 하고, `auth_attempts`까지 12개 테이블이 다
생겼는지 확인한 뒤 `/tmp/prod.env`를 지웁니다.

**4-4. 보드로 눈으로 확인.** `pnpm serve`를 프로덕션 DB에 물리지 마세요 — `routes: "local"`이라
**발송이 무조건 열립니다.** `serve:hosted`를 쓰세요:

```bash
pnpm build:web
HERALD_TRUST_PROXY=true npx tsx --env-file=/tmp/prod.env src/cli/serve-hosted.ts
```

`/tmp/prod.env`에는 인증 3종이 없어 로그인이 안 되니, 보드를 봐야 하면 **일회용** 계정을 그
파일에 임시로 더하세요(Vercel에는 등록하지 않습니다). 팀 비밀번호를 쓸 이유가 없습니다 —
프로덕션 DB에 인증 설정이 저장되지는 않습니다.

기동 로그의 `Sends are CLOSED`를 확인하고 들어가세요. **아무것도 발송하지 마세요.**

### 5. 배포 전 로컬 리허설 (선택)

프리뷰 배포가 꺼져 있어 호스팅 리허설이 없습니다. 대신 서버 두 개를 같은 일회용 DB에 물립니다.
5757이 대조군(`routes: "local"`), 5758이 호스팅과 같은 화면입니다. 같은 행이 5757에서 활성
`발송`, 5758에서 `발송 · 잠김`이면 정상입니다.

**5757에서는 `[발송]`을 누르지 마세요 — 로컬 진입점은 발송이 항상 열려 있어 진짜로 나갑니다.**

### 6. 실 URL 체크리스트 (1280px, 390px 둘 다)

로그아웃 상태 → `#login` / 틀린 비밀번호 거부, 5회 후 IP 잠금 / 로그인 → 보드 로드 /
1차·2차 편집·승인 후 새로고침 유지 / **`[변환 준비]` 없음**(대신 "이 배포에서는 워크시트를
준비할 수 없습니다") / **`[발송]`이 `발송 · 잠김`** / 상단 발송 차단 배너 /
`개발 데이터베이스` 배너 **없음** / 로그아웃 → 세션 종료 / 다른 오리진 위조 요청 403.

### 7. 로컬 경로 정리

프로덕션이 신뢰되면 `output/`의 검수 상태는 죽은 사본이고 누군가 최신으로 착각할 수 있습니다.
`pnpm archive` — 삭제가 아니라 보관이고, 롤백이 필요하면 `db:export`가 다시 만들어 줍니다.

</details>

---

## 참고

- 처음 세우는 절차: [`setup/vercel.md`](setup/vercel.md)
- 환경변수 전체 레퍼런스: [`env.md`](env.md), `.env.example` §5·§6
- 팀 운영: [`team-runbook.md`](team-runbook.md)
