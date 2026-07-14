# Google Drive 셋업 가이드 (서브시스템 D)

> `pnpm drive:publish`가 Google Drive에 업로드하려면 `.env`에 아래 값을 채워야 합니다:
> `GOOGLE_SA_KEY_FILE`, `GDRIVE_SHARE_EMAILS`, `GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`.
>
> **최소 권한 설계:** OAuth 스코프는 좁은 **`drive.file`** 이라, 서비스 계정은 **자기가 만든 파일만**
> 접근합니다(다른 드라이브 전체엔 손 못 댐). 그래서 **폴더도 서비스 계정이 직접 만들고**(`pnpm drive:init`),
> 그 폴더를 팀에 공유합니다 — 사람이 미리 만든 폴더를 넘겨줄 필요가 없어요.

---

## 0. 준비물

- Google 계정 + [Google Cloud Console](https://console.cloud.google.com) 접근 권한
- 폴더를 공유받을 **팀원 이메일**들 (편집자 권한을 줄 대상)

---

## 1. GCP 프로젝트 선택/생성

1. https://console.cloud.google.com 접속
2. 상단 프로젝트 선택기 → 기존 프로젝트 선택 또는 **New Project** 생성 (예: `mantle-kr-herald`)

> GCP는 **인증/API 관문**일 뿐이고, 실제 파일은 일반 구글 드라이브에 저장됩니다. 무료(프로젝트 생성·Drive
> API 쿼터 무료)이고 VM 같은 인프라는 안 띄웁니다.

---

## 2. Google Drive API 사용 설정

1. 왼쪽 메뉴 **APIs & Services → Library** (또는 검색창에 "Google Drive API")
2. **Google Drive API** 클릭 → **Enable**
   - 안 켜면 업로드 시 403(API not enabled) 오류가 납니다.

---

## 3. 서비스 계정 생성 + JSON 키 → `GOOGLE_SA_KEY_FILE`

1. **APIs & Services → Credentials** → **Create Credentials** → **Service account**
   (또는 **IAM & Admin → Service Accounts → Create Service Account**)
2. 이름 입력 (예: `mantle-kr-herald-uploader`) → **Create and Continue** → 역할은 비워도 됨 → **Done**
3. 그 서비스 계정 → **Keys** 탭 → **Add Key → Create new key → JSON** → **Create**
   - `.json` 파일이 다운로드됩니다. 로컬 안전한 위치로 옮기세요 (예: `~/keys/mantle-sa.json`).
   - ⚠️ 이 키는 비밀번호와 같은 **장기 자격증명**입니다 — 절대 커밋·공유 금지. `chmod 600` 권장, 주기적 회전.
4. `.env`에 그 **파일 경로**를 넣습니다:
   ```bash
   GOOGLE_SA_KEY_FILE=/home/kyle/keys/mantle-sa.json
   ```

> (`drive.file` 스코프라 이 키가 유출돼도 도달 범위는 **서비스 계정이 만든 파일만**입니다 — 드라이브 전체가
> 아니라서 블래스트 반경이 작아요.)

---

## 4. 폴더 자동 생성 + 팀 공유 → `pnpm drive:init`

서비스 계정이 review/approved 폴더를 **직접 만들고** 팀에 **편집자(editor)** 로 공유합니다.

1. `.env`에 공유할 **팀 이메일**을 콤마로 넣습니다:
   ```bash
   GDRIVE_SHARE_EMAILS=alice@yourteam.com,bob@yourteam.com
   ```
   (비워두면 폴더는 만들어지지만 아무도 못 봐요 — 나중에 채우고 다시 돌리거나 공유 추가.)
2. 실행:
   ```bash
   pnpm drive:init
   ```
3. 출력된 두 줄을 그대로 `.env`에 붙여넣습니다:
   ```bash
   GDRIVE_REVIEW_FOLDER_ID=<출력된 review 폴더 ID>
   GDRIVE_APPROVED_FOLDER_ID=<출력된 approved 폴더 ID>
   ```

> ⚠️ `drive:init`은 **한 번만** 실행하세요. 다시 돌리면 같은 이름의 폴더가 **또 생깁니다**(중복). 폴더 ID를
> 잃어버렸거나 다시 만들고 싶을 때만 재실행.
>
> 폴더는 서비스 계정 소유라 팀원의 **"공유 문서함(Shared with me)"** 에 나타납니다. 편집자 권한이라 드라이브에서
> 바로 확인·수정·승인할 수 있어요. (원하면 각자 "내 드라이브에 바로가기 추가")

---

## 5. 검증

```bash
# 실제 업로드 probe (자격증명 있을 때만 실행됨)
pnpm test tests/adapters/drive/drive.probe.test.ts

# 실제 업로드
pnpm drive:publish --target google
```
review 폴더에 `.md` 파일이 올라오고, 공유한 팀원이 열어볼 수 있으면 성공입니다.

---

## 6. 자주 나는 오류

| 증상 | 원인 / 해결 |
| --- | --- |
| `HTTP 403 ... Google Drive API has not been used` | Drive API 미사용 설정(§2) |
| `Invalid Google service account key file` | `GOOGLE_SA_KEY_FILE` 경로 오류 또는 JSON 손상 |
| `HTTP 401` | 키 파일이 잘못됨/폐기됨 → 새 키 발급(§3) |
| `drive:init` 후 팀원이 폴더를 못 봄 | `GDRIVE_SHARE_EMAILS` 비었거나 오타 → 채우고 재실행(또는 공유 추가) |
| `HTTP 404 File not found: <folder id>` | `.env`의 폴더 ID가 `drive:init` 출력과 다름(오타) |

> **보안:** 서비스계정 JSON 키·access token·`.env`는 절대 공유·커밋하지 마세요. 각자 로컬에서만 사용합니다.
> 스코프가 `drive.file`이라 서비스 계정은 **자기가 만든 폴더/파일 밖으론 접근 못 합니다**(최소 권한).
