# Google Drive 셋업 가이드 (서브시스템 D)

> `pnpm drive:publish`가 Google Drive에 업로드하려면 아래 3개 값을 `.env`에 채워야 합니다.
> `GOOGLE_SA_KEY_FILE`, `GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`.
>
> 인증은 **서비스 계정(Service Account)** 방식입니다 — 사람이 매번 로그인하지 않고 코드가 자동으로
> 인증하는 봇 계정이에요.

---

## 0. 준비물

- Google 계정 + [Google Cloud Console](https://console.cloud.google.com) 접근 권한
- 업로드 대상이 될 Google Drive (개인 또는 공유 드라이브)

---

## 1. GCP 프로젝트 선택/생성

1. https://console.cloud.google.com 접속
2. 상단 프로젝트 선택기 → 기존 프로젝트 선택 또는 **New Project** 생성 (예: `mantle-kr-herald`)

---

## 2. Google Drive API 사용 설정

1. 왼쪽 메뉴 **APIs & Services → Library** (또는 검색창에 "Google Drive API")
2. **Google Drive API** 클릭 → **Enable**
   - 이걸 안 켜면 업로드 시 403(API not enabled) 오류가 납니다.

---

## 3. 서비스 계정 생성 → 이메일 확보

1. **APIs & Services → Credentials** → **Create Credentials** → **Service account**
   (또는 **IAM & Admin → Service Accounts → Create Service Account**)
2. 이름 입력 (예: `mantle-kr-herald-uploader`) → **Create and Continue** → 역할은 비워도 됨 → **Done**
3. 생성된 서비스 계정을 클릭 → 상단의 **이메일**을 복사해 둡니다.
   형식: `mantle-kr-herald-uploader@<project-id>.iam.gserviceaccount.com`
   → **4단계에서 이 이메일로 폴더를 공유**합니다. (⚠️ 이 이메일이 핵심)

### 3-1. JSON 키 발급 → `GOOGLE_SA_KEY_FILE`

1. 그 서비스 계정 → **Keys** 탭 → **Add Key → Create new key → JSON** → **Create**
2. `.json` 파일이 다운로드됩니다. 로컬 안전한 위치로 옮기세요 (예: `~/keys/mantle-sa.json`).
   ⚠️ 이 키는 비밀번호와 같습니다 — **절대 커밋·공유 금지**.
3. `.env`에 그 **파일 경로**를 넣습니다:
   ```bash
   GOOGLE_SA_KEY_FILE=/home/kyle/keys/mantle-sa.json
   ```

---

## 4. review / approved 폴더 만들고 서비스 계정과 공유

서비스 계정은 **자기에게 공유된 폴더에만** 접근할 수 있습니다. 그래서 공유가 필수예요.

1. Google Drive에서 폴더 **2개** 생성 (예: `Mantle KR — 검수(review)`, `Mantle KR — 승인(approved)`)
2. 각 폴더 우클릭 → **Share(공유)** → 3단계에서 복사한 **서비스 계정 이메일**을 입력 →
   권한 **Editor(편집자)** → 전송.
   (알림 이메일은 서비스 계정이 받을 수 없어 실패 표시가 떠도 공유 자체는 정상 적용됩니다.)

### 4-1. 폴더 ID 확보 → `GDRIVE_*_FOLDER_ID`

각 폴더를 열면 브라우저 주소가 이렇게 생겼습니다:
```
https://drive.google.com/drive/folders/1AbCdEfGhIJKlmNOPqrStUvWxYz
                                        └──────── FOLDER_ID ────────┘
```
마지막 세그먼트가 폴더 ID입니다. `.env`에:
```bash
GDRIVE_REVIEW_FOLDER_ID=<검수 폴더 ID>
GDRIVE_APPROVED_FOLDER_ID=<승인 폴더 ID>
```

---

## 5. 검증

`.env`를 채운 뒤:

```bash
# 인증 + 실제 업로드 probe (자격증명 있을 때만 실행됨)
pnpm test tests/adapters/drive/drive.probe.test.ts

# 실제 업로드
pnpm drive:publish --target google
```
검수 폴더에 `.md` 파일이 실제로 올라오면 성공입니다.

---

## 6. 자주 나는 오류

| 증상 | 원인 / 해결 |
| --- | --- |
| `HTTP 404 File not found: <folder id>` | 폴더를 **서비스 계정 이메일과 공유** 안 함(§4), 또는 폴더 ID 오타 |
| `HTTP 403 ... Google Drive API has not been used` | Drive API 미사용 설정(§2) |
| `Invalid Google service account key file` | `GOOGLE_SA_KEY_FILE` 경로 오류 또는 JSON 손상 |
| `HTTP 401` | 키 파일이 잘못됨/폐기됨 → 새 키 발급(§3-1) |

> **보안:** 서비스계정 JSON 키·access token·`.env`는 절대 공유·커밋하지 마세요. 각자 로컬에서만 사용합니다.
