# Google Drive 셋업 가이드 (서브시스템 D)

> `pnpm drive:publish`가 Google Drive에 업로드하려면 `.env`에 **인증**(아래 방법 A 또는 B) + **폴더 ID**
> (`GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`)가 필요합니다.
>
> **핵심:** **서비스계정은 저장 용량이 0**이라 **개인 Gmail 드라이브에는 파일을 못 올립니다**(업로드 시
> `403 storageQuotaExceeded`). 그래서 개인 계정은 **방법 A(OAuth)**, Google Workspace의 **공유 드라이브
> (Shared Drive)** 가 있을 때만 **방법 B(서비스계정)** 를 씁니다.

---

## 0. 어떤 방식을 쓸까?

|             | **방법 A — OAuth** (개인 Gmail 권장) | **방법 B — 서비스계정** (Workspace 확장용) |
| ----------- | ------------------------------------ | ------------------------------------------ |
| 파일 소유자 | **너 자신**                          | 공유 드라이브                              |
| 저장 할당량 | 있음(네 15GB)                        | 공유 드라이브                              |
| 개인 Gmail  | ✅ 됨                                | ❌ 업로드 403                              |
| 셋업        | OAuth 동의 1회 → refresh token       | SA 키 + 공유 드라이브                      |

→ **개인 Gmail이면 방법 A.** Workspace + 공유 드라이브가 있을 때만 방법 B가 의미 있습니다.
스코프는 두 방식 모두 좁은 **`drive.file`**(앱이 만든 파일만 접근) 최소권한을 씁니다.

---

## 공통 1. GCP 프로젝트 + Drive API 사용 설정

1. https://console.cloud.google.com → 상단 프로젝트 선택기 → 기존 선택 또는 **New Project**(예: `mantle-kr-herald`)
2. **APIs & Services → Library** → "Google Drive API" → **Enable**
   - 안 켜면 업로드 시 403(API not enabled).

> GCP는 **인증/API 관문**일 뿐, 실제 파일은 일반 구글 드라이브에 저장됩니다. 무료이고 VM 등은 안 띄웁니다.

---

## 방법 A — OAuth (개인 Gmail 권장)

앱이 **"너로서"** 동작하므로 파일이 네 소유가 되고(할당량 O), 업로드가 됩니다.

### A-1. OAuth 동의 화면 구성

1. **APIs & Services → OAuth consent screen** → User Type **External** → Create
2. **App name(앱 이름): `Mantle KR Herald`** (동의 화면에 표시될 이름 — 아무거나 돼도 이걸 권장) / User support email: 네 Gmail / Developer contact: 네 Gmail (나머진 기본값)
3. **Test users** 에 **네 Gmail 주소를 추가** (테스트 모드에선 등록된 사용자만 로그인 가능)

### A-2. OAuth 클라이언트 ID 생성 (Desktop app)

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Desktop app** ← 중요(로컬 `127.0.0.1` 리디렉트가 자동 허용됨) / **Name(이름): `mantle-kr-herald-desktop`** (내부 식별용 — 아무거나 OK)
3. 생성된 **Client ID / Client secret** 을 `.env`에:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=xxxx
   ```
   > 생성 후 화면에 **Client ID / Client secret**이 뜨고 **JSON 다운로드**도 제공되는데, OAuth 방식은 **JSON 파일은 쓰지 않습니다** — 이 **두 값만** 위처럼 `.env`에 복사하세요. (JSON을 파일로 저장해 쓰는 건 방법 B(서비스계정)뿐입니다.)
   > Desktop 앱의 secret은 엄밀히는 "진짜 비밀"이 아니지만(배포 앱에 내장되는 값), 그래도 `.env`(git-ignored)에만 둡니다.

### A-3. refresh token 발급 → `pnpm google:auth`

```bash
pnpm google:auth
```

1. 출력된 URL을 **같은 PC의 브라우저**에서 열고 네 계정으로 **승인**
2. "이 앱은 Google에서 확인하지 않았습니다" 경고가 나오면 **고급 → (안전하지 않은 페이지로) 이동** — 테스트 유저라 정상입니다
3. 승인하면 터미널에 아래가 출력됩니다. 그 줄을 `.env`에 붙여넣으세요:
   ```bash
   GOOGLE_OAUTH_REFRESH_TOKEN=1//0g...
   ```

> **WSL 사용 시:** 서버는 WSL 안 `127.0.0.1:<포트>`에서 대기합니다. URL을 복사해 **Windows 브라우저**에 붙여
> 넣으면, 승인 후 `127.0.0.1`로의 리디렉트가 WSL2 localhost 포워딩으로 WSL 서버까지 도달해 자동 완료됩니다.
>
> 스코프는 기본 `drive.file`(최소권한). 필요할 때만 `GOOGLE_OAUTH_SCOPE`로 넓히세요.

→ **[공통 2. 폴더 생성](#공통-2-폴더-자동-생성--pnpm-driveinit)** 으로 이동.

---

## 방법 B — 서비스계정 (Workspace + Shared Drive, 확장용)

> ⚠️ **개인 Gmail에선 업로드 불가**(SA 저장 용량 0 → `403 storageQuotaExceeded`). Google Workspace의
> **공유 드라이브(Shared Drive)** 가 있을 때만 의미가 있습니다. 지금은 방법 A를 권장하고, 이 경로는 향후
> 조직 계정으로 확장할 때를 위해 남겨둡니다.

### B-1. 서비스계정 + JSON 키

1. **APIs & Services → Credentials → Create Credentials → Service account** (또는 **IAM & Admin → Service Accounts**)
2. **이름(Service account name): `mantle-kr-herald-uploader`** → Create → 역할 비워도 됨 → Done
3. 해당 SA → **Keys** → **Add Key → Create new key → JSON** → 다운로드
4. 받은 `.json`을 레포 **`keys/`** 폴더로 옮기고(예: `keys/mantle-sa.json`) `.env`에:
   ```bash
   GOOGLE_AUTH_MODE=service_account
   GOOGLE_SA_KEY_FILE=keys/mantle-sa.json
   ```
   `keys/`는 `.gitignore`로 실제 키가 커밋되지 않습니다(`keys/README.md`만 추적). ⚠️ 키는 장기 자격증명 — 절대 커밋·공유 금지, `chmod 600` 권장.

### B-2. 공유 드라이브에 SA 추가

- Workspace **공유 드라이브** → 멤버 관리 → **SA 이메일**(`...@...iam.gserviceaccount.com`)을 **콘텐츠 관리자/편집자**로 추가.
- 이후 폴더 생성/업로드는 공유 드라이브 안에서 이뤄져야 합니다(파일 소유자가 공유 드라이브라 SA 할당량 문제 없음).

> 참고: 공유 드라이브 완전 지원(`supportsAllDrives`)은 추후 확장 항목입니다. 현재 검증된 경로는 방법 A(OAuth)예요.

---

## 공통 2. 폴더 자동 생성 → `pnpm drive:init`

`drive:init`이 폴더 구조를 만들고 팀에 **편집자**로 공유합니다. 구조:

```
Mantle KR Herald   ← 상위 폴더 (이 하나만 팀 공유; 하위는 상속)
├─ review          ← GDRIVE_REVIEW_FOLDER_ID
└─ approved        ← GDRIVE_APPROVED_FOLDER_ID
```

> **`GDRIVE_REVIEW_FOLDER_ID`는 "경로"가 아니라 폴더 "ID"**(`1AbCdEf…`)입니다. 직접 타이핑하지 말고
> `drive:init` 출력값을 붙여넣으세요.

1. `.env`에 공유할 **팀 이메일**:
   ```bash
   GDRIVE_SHARE_EMAILS=alice@yourteam.com,bob@yourteam.com
   ```
   (비워도 폴더는 생성됨 — 나중에 채우고 **다시 돌리면 그때 공유**됩니다.)
   상위 폴더 이름 변경(선택): `GDRIVE_PARENT_FOLDER_NAME=...` (기본 `Mantle KR Herald`).
2. 실행:
   ```bash
   pnpm drive:init
   ```
3. 출력된 두 줄을 `.env`에 붙여넣기:
   ```bash
   GDRIVE_REVIEW_FOLDER_ID=<출력된 review ID>
   GDRIVE_APPROVED_FOLDER_ID=<출력된 approved ID>
   ```

> **방법 A(OAuth)** 에선 폴더가 **네 My Drive**에 생기고 **네 소유**입니다(팀엔 편집자 공유). 원하는 위치가 있으면
> (예: `1Meetup/MANTLE`) 생성된 "Mantle KR Herald"를 그 폴더로 **드래그**하면 됩니다 — 앱이 만든 파일이라 이동
> 후에도 접근이 유지돼요.
>
> `drive:init`은 **멱등** — 같은 이름 폴더가 있으면 재사용하고 ID를 다시 출력합니다. **공유는 매 실행마다 보장**
> (이미 공유된 이메일은 스킵, 새 이메일만 추가). 새로 만들려면 `--force`.

---

## 공통 3. 모드 선택 (`GOOGLE_AUTH_MODE`)

- **자동 감지:** `GOOGLE_OAUTH_REFRESH_TOKEN`이 있으면 `oauth`, 없고 `GOOGLE_SA_KEY_FILE`이 있으면 `service_account`.
- **강제:** `GOOGLE_AUTH_MODE=oauth` 또는 `service_account`.

---

## 공통 4. 검증

```bash
# .env를 읽어 라이브 probe 실행 (자격증명 있는 것만; 없으면 skip)
pnpm probe tests/adapters/drive/drive.probe.test.ts

# 실제 업로드
pnpm drive:publish --target google
```

review 폴더에 `.md`가 올라오고 공유한 팀원이 열어볼 수 있으면 성공입니다.

> `pnpm probe`는 `.env`를 로드합니다(일반 `pnpm test`는 안 읽어 skip). 인증 probe는 설정된 방식(oauth/서비스
> 계정) 토큰을 발급해 보고, `GDRIVE_REVIEW_FOLDER_ID`까지 있으면 review 폴더에 throwaway `.md`를 올려 봅니다.

---

## 공통 5. 자주 나는 오류

| 증상                                                                          | 원인 / 해결                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `403 ... Service Accounts do not have storage quota` (`storageQuotaExceeded`) | 개인 계정에 **서비스계정**을 씀 → **방법 A(OAuth)로 전환**                                                                      |
| `pnpm google:auth`가 refresh token을 안 냄                                    | 이미 동의한 앱 — 재실행하면 `prompt=consent`라 다시 발급됩니다. 그래도 안 나오면 계정의 "서드파티 앱 액세스"에서 제거 후 재시도 |
| "이 앱은 Google에서 확인하지 않았습니다"                                      | 테스트 모드라 정상 — **고급 → 이동**. 또는 OAuth 동의화면 **Test users**에 본인 이메일 추가                                     |
| `redirect_uri_mismatch`                                                       | OAuth 클라이언트 타입이 **Desktop app**인지 확인(127.0.0.1 자동 허용)                                                           |
| `403 ... Google Drive API has not been used`                                  | Drive API 미사용 설정(공통 1)                                                                                                   |
| `HTTP 404 File not found: <folder id>`                                        | `.env`의 폴더 ID가 `drive:init` 출력과 다름(오타)                                                                               |
| `drive:init` 후 팀원이 폴더를 못 봄                                           | `GDRIVE_SHARE_EMAILS` 비었거나 오타 → 채우고 재실행                                                                             |

> **보안:** OAuth refresh token·서비스계정 키·access token·`.env`는 절대 공유·커밋하지 마세요. 각자 로컬에서만
> 사용합니다. 스코프는 `drive.file`이라 앱은 **자기가 만든 파일 밖으론 접근 못 합니다**(최소 권한).
