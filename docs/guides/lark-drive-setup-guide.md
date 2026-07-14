# Lark Drive 셋업 가이드 (서브시스템 D)

> `pnpm drive:publish`가 Lark Drive에 업로드하려면 아래 2개 값을 `.env`에 채워야 합니다.
> `LARK_DRIVE_REVIEW_FOLDER_TOKEN`, `LARK_DRIVE_APPROVED_FOLDER_TOKEN`.
>
> **인증은 서브시스템 B에서 만든 Lark 앱을 그대로 재사용**합니다 (`LARK_APP_ID` / `LARK_APP_SECRET`).
> 앱을 아직 안 만들었다면 먼저 [lark-setup-guide.md](./lark-setup-guide.md)를 따라 만드세요.

---

## 0. 준비물

- 서브시스템 B에서 만든 **Lark 커스텀 앱** (`LARK_APP_ID` / `LARK_APP_SECRET` 이미 `.env`에 있음)
- 업로드 대상이 될 Lark Drive 폴더

---

## 1. 앱에 Drive 스코프 추가

기존 Lark 앱은 메시지 읽기 스코프(`im:message.history:readonly`)만 있으니, **드라이브 업로드 권한**을 추가합니다.

1. [Lark Developer Console](https://open.larksuite.com/app) → 그 앱 선택
2. **Permissions & Scopes**(권한 관리) → 아래 중 하나 추가:
   - **`drive:drive`** — 클라우드 문서 전체 관리 (권장)
   - 또는 **`drive:file`** — 파일 업로드/다운로드 (더 좁은 권한)
3. **Version Management & Release**(버전 관리) → **Create Version** → 제출 → 관리자 승인
   (⚠️ 스코프를 추가하면 **새 버전 릴리스(승인)** 를 해야 실제로 적용됩니다.)

---

## 2. review / approved 폴더 만들고 앱과 공유

앱(봇)은 **접근 권한이 있는 폴더에만** 업로드할 수 있습니다.

1. Lark Drive에서 폴더 **2개** 생성 (예: `Mantle KR — 검수(review)`, `Mantle KR — 승인(approved)`)
2. 각 폴더를 **앱/봇이 접근 가능하도록 공유** (폴더 공유 설정에서 봇 추가, 또는 봇이 속한 그룹의 공유
   드라이브 사용).

---

## 3. 폴더 token 확보 → `LARK_DRIVE_*_FOLDER_TOKEN`

Lark의 `parent_node`는 **폴더 token**입니다. (upload_all API가 요구하는 값)

**방법 A — 폴더 URL에서 (가장 간단)**

Lark Drive에서 폴더를 열면 주소가 이렇게 생겼습니다:
```
https://<your-domain>.larksuite.com/drive/folder/fldcnXXXXXXXXXXXXXXXX
                                                  └──── FOLDER_TOKEN ────┘
```
`/drive/folder/` 뒤의 값이 폴더 token입니다 (보통 `fldcn…` 또는 `nod…`로 시작).

**방법 B — API Explorer**

개발자 콘솔 → **API Explorer** → `GET /open-apis/drive/v1/files`(내 드라이브 목록) 또는 상위 폴더의
children 조회로 `token`을 확인. (앱이 폴더에 접근 가능해야 보입니다.)

`.env`에:
```bash
LARK_DRIVE_REVIEW_FOLDER_TOKEN=<검수 폴더 token>
LARK_DRIVE_APPROVED_FOLDER_TOKEN=<승인 폴더 token>
```

> `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_BASE_URL`은 B에서 이미 채웠으니 그대로 씁니다.

---

## 4. 검증

`.env`를 채운 뒤:

```bash
# 실제 업로드 probe (자격증명 있을 때만 실행됨)
pnpm test tests/adapters/drive/drive.probe.test.ts

# 실제 업로드
pnpm drive:publish --target lark
```
검수 폴더에 `.md` 파일이 실제로 올라오면 성공입니다.

---

## 5. 자주 나는 오류

| 증상 | 원인 / 해결 |
| --- | --- |
| `code 1061045` / no permission | Drive 스코프 미승인 또는 **버전 릴리스 안 함**(§1), 또는 폴더 미공유(§2) |
| `code 99991663` / token invalid | `LARK_APP_ID`/`SECRET` 오타 또는 리전 불일치(Larksuite↔Feishu) |
| 업로드는 되는데 폴더에 안 보임 | `parent_node`(폴더 token) 오타(§3), 다른 폴더로 올라감 |
| `HTTP 4xx/5xx` | 파일 20MB 초과(md는 해당 없음) 또는 일시 오류 → 재시도 |

> **보안:** `LARK_APP_SECRET`·tenant token·`.env`는 절대 공유·커밋하지 마세요. 각자 로컬에서만 사용합니다.
