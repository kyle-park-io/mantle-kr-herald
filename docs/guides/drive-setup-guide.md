# 드라이브 셋업 가이드 — Google Drive + Lark Drive (서브시스템 D)

> `pnpm publish`가 번역 결과를 두 드라이브에 올리려면 아래 값을 `.env`에 채워야 합니다.

## Google Drive

1. **GCP 프로젝트** (console.cloud.google.com) → 없으면 생성.
2. **Google Drive API 사용 설정**: APIs & Services → Enable APIs → "Google Drive API" 검색 → 사용.
3. **서비스 계정 생성**: IAM & Admin → Service Accounts → Create → 이름 지정 → 완료. 생성된 서비스
   계정 **이메일**(…@….iam.gserviceaccount.com)을 복사.
4. **JSON 키 발급**: 그 서비스 계정 → Keys → Add Key → JSON → 다운로드. 파일 경로를 `.env`의
   `GOOGLE_SA_KEY_FILE`에.
5. **폴더 공유**: Google Drive에서 review용 / approved용 폴더를 각각 만들고, 각 폴더를 **서비스 계정
   이메일과 편집자(Editor)로 공유**. (서비스 계정은 자기 소유 파일만 접근하므로 공유가 필수)
6. **폴더 ID**: 폴더 URL `https://drive.google.com/drive/folders/<FOLDER_ID>`의 `<FOLDER_ID>`를
   `.env`의 `GDRIVE_REVIEW_FOLDER_ID` / `GDRIVE_APPROVED_FOLDER_ID`에.

## Lark Drive

1. **B에서 만든 Lark 앱**을 그대로 사용 (`LARK_APP_ID`/`LARK_APP_SECRET`).
2. **Drive 스코프 추가**: 앱 → Permissions & Scopes → `drive:drive`(또는 파일 업로드 권한) 추가 →
   버전 릴리스(승인).
3. **대상 폴더**: Lark Drive에서 review / approved 폴더 생성 → 앱(봇)이 접근 가능하도록 공유.
4. **폴더 token**: 폴더 URL의 토큰을 `.env`의 `LARK_DRIVE_REVIEW_FOLDER_TOKEN` /
   `LARK_DRIVE_APPROVED_FOLDER_TOKEN`에.

## 실행

```bash
pnpm publish                 # 둘 다
pnpm publish --target google # 구글만
pnpm publish --target lark   # Lark만
```
`output/publish-state.json`이 (아이템:상태:드라이브)별로 업로드 이력을 기록해 중복 업로드를 막습니다.
