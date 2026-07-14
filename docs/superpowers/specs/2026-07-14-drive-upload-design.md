# 설계: 서브시스템 D — 드라이브 업로드 (Google + Lark)

- **작성일:** 2026-07-14
- **서브시스템:** D — 드라이브 업로드 (`proposal.md` §2)
- **상태:** 설계 확정 대기 → 구현 계획(writing-plans)으로 이어짐
- **브랜치:** `feat/drive-upload` (C `feat/kr-translation` 위에 stack — `Translation` 소비. 스택: A→B→C→D)

> 코드/식별자/주석은 영어, 설명은 한국어. 파이프라인의 네 번째 서브시스템. 이전:
> A `2026-07-14-x-data-collection-design.md`, B `2026-07-14-lark-data-collection-design.md`,
> C `2026-07-14-kr-translation-design.md`.

---

## 1. 목적

C의 번역 결과를 **Google Drive와 Lark Drive 둘 다**에 코드(REST)로 업로드하여, KR 팀이 드라이브에서
진행상황을 보고 1차 검수할 수 있게 한다(proposal §2 흐름: 번역 → **1차 드라이브 업로드** → 검수).
헤드리스 `pnpm drive:publish`로 자동화되며, A/B/C와 동일한 로컬 실행 원칙을 따른다.

## 2. 범위

**포함 (in scope)**
- C의 `output/translations.json`을 읽어 두 드라이브에 업로드 (both, 코드 REST)
- 상태별 분기: `translated` → **원문+한글 검수본** → review 폴더 / `approved` → **한글-only 최종본** → approved 폴더(별도)
- **Markdown 파일**로 렌더·업로드 (Google Doc 변환 없이 `.md` 그대로)
- 멱등: 이미 올린 `(itemId, status)` 조합은 재업로드 안 함 (publish state 추적)
- Google 인증: **서비스계정 JWT를 `node:crypto`로 직접 서명**(신규 런타임 의존성 0). B의 `LarkAuth` 토큰
  캐싱 패턴 재사용
- Lark 인증: **B의 Lark 앱**(`LARK_APP_ID/SECRET`) + Drive 스코프 재사용

**제외 (out of scope)**
- 업로드 후 Lark 알림(§2 "Lark 알림") — 봇(H) 영역
- 대시보드 편집·승인(§4/§7) — E
- Google Doc/Lark Doc 네이티브 변환 (md 파일만)
- `googleapis` 등 대형 라이브러리 (node:crypto로 직접 서명)

## 3. 아키텍처

헥사고날. shared HttpClient/store 재사용. B의 `LarkAuth` 재사용(Lark Drive 토큰).

```
src/
  domain/publish/
    renderers.ts            # 순수: renderReview(t)→md(원문+한글), renderApproved(t)→md(한글), safeFileName(id)
    publishModels.ts        # UploadRequest{ name, content, folder: FolderKind }, FolderKind="review"|"approved"
  ports/
    DriveUploader.ts        # upload(req): Promise<UploadResult{ id, name }>
    PublishStore.ts         # listPublished(): Promise<Set<string>> / record(key): Promise<void>
  adapters/
    drive/
      GoogleAuth.ts         # 서비스계정 JWT(RS256, node:crypto) → access_token 캐시/갱신
      GoogleDriveUploader.ts# Drive API v3 multipart 업로드 (folder id 매핑)
      LarkDriveUploader.ts  # Lark Drive upload_all (LarkAuth 재사용, folder token 매핑)
    store/JsonPublishStore.ts  # output/publish-state.json (shared/store)
  app/PublishTranslations.ts   # 번역 읽기 → 렌더 → review/approved 업로드 → 기록 (멱등)
  cli/publish.ts               # composition root (--target google|lark|both)
  config.ts                    # + loadGoogleDriveConfig(), loadLarkDriveConfig()
```

## 4. 도메인 (순수)

```ts
// domain/publish/publishModels.ts
export type FolderKind = "review" | "approved";
export interface UploadRequest { name: string; content: string; folder: FolderKind; }
export interface UploadResult { id: string; name: string; }

// domain/publish/renderers.ts  (Translation from C: src/domain/translation/models.ts)
export function renderReview(t: Translation): string;    // "# <id>\n\n## 원문\n<src>\n\n## 한글\n<ko>\n"
export function renderApproved(t: Translation): string;  // 한글 본문만
export function safeFileName(itemId: string): string;    // "x:100" → "x-100.md" (콜론/슬래시 치환)
```

## 5. 포트

```ts
// ports/DriveUploader.ts
export interface DriveUploader {
  upload(req: UploadRequest): Promise<UploadResult>;
  readonly name: string; // "google" | "lark" (결과 보고용)
}
// ports/PublishStore.ts
export interface PublishStore {
  listPublished(): Promise<Set<string>>;      // 키셋 "<itemId>:<status>:<drive>" (per-drive)
  record(key: string): Promise<void>;
}
```
> 각 업로더는 자기 리뷰/승인 폴더를 생성자에 주입받아 `req.folder`(review/approved)로 매핑한다.
> C의 `TranslationStore`(read)를 그대로 재사용해 `loadAll()`로 번역을 읽는다.
> 멱등 키는 **드라이브별**(`<itemId>:<status>:<drive>`)이라, 한 드라이브 실패 시 그 드라이브만 다음
> 실행에서 재시도되고 성공한 드라이브엔 중복 업로드가 없다. 유스케이스가 업로더들을 직접 순회하므로
> 별도 MultiUploader는 두지 않는다(YAGNI).

## 6. 어댑터

### 6-1. `GoogleAuth` (서비스계정 JWT, node:crypto)
- SA JSON 키(`client_email`, `private_key`)를 읽어, `getToken()`이 access_token을 캐시/갱신.
- JWT: header `{alg:"RS256",typ:"JWT"}` + claim `{iss:client_email, scope:"https://www.googleapis.com/auth/drive.file", aud:"https://oauth2.googleapis.com/token", iat, exp:iat+3600}`.
  (최소 권한 `drive.file` — SA는 자기가 만든 파일만 접근. 그래서 폴더도 SA가 `drive:init`으로 직접 생성·공유.)
  base64url 인코딩 후 `crypto.sign("RSA-SHA256", data, private_key)`로 서명.
- `POST https://oauth2.googleapis.com/token` (form-urlencoded: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<JWT>`) → `{access_token, expires_in}`. 만료 60초 전 갱신(LarkAuth 패턴).
- 토큰 엔드포인트는 form-urlencoded라 shared JSON HttpClient 대신 네이티브 `fetch` 사용.

### 6-2. `GoogleDriveUploader`
- 생성자: `(auth: GoogleAuth, folders: Record<FolderKind, string>)` (folder id).
- `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`, `Authorization: Bearer <token>`,
  body = **multipart/related**: 메타파트 `{name, parents:[folderId]}`(application/json) + 미디어파트(`text/markdown`, 내용).
  → `{id, name}`.

### 6-3. `LarkDriveUploader`
- 생성자: `(auth: LarkAuth, baseUrl, folders: Record<FolderKind, string>)` (folder token).
- `POST <baseUrl>/open-apis/drive/v1/files/upload_all`, `Authorization: Bearer <tenant_token>`,
  **multipart/form-data**: `file_name`, `parent_type=explorer`, `parent_node=<folder_token>`, `size`, `file`.
  → `{file_token}` → `UploadResult{ id:file_token, name }`. code!=0 에러.
- **B의 `LarkAuth`를 그대로 재사용**(같은 tenant token). 앱에 Drive 스코프 필요.

## 7. 유스케이스 & 데이터 흐름

### `PublishTranslations` (`pnpm drive:publish`)
```
published = publishStore.listPublished()           # {"<itemId>:<status>:<drive>"}
for t in translationStore.loadAll():
  const doc = t.status === "approved" ? renderApproved(t) : renderReview(t)
  const folder = t.status === "approved" ? "approved" : "review"
  const name = safeFileName(t.itemId)
  for uploader of uploaders:                        # 예: [google, lark]
    key = `${t.itemId}:${t.status}:${uploader.name}`
    if published.has(key): continue
    await uploader.upload({ name, content: doc, folder })
    await publishStore.record(key)                  # 그 드라이브 성공 후에만 (재시도·부분실패 안전)
return { uploaded, byDrive }
```
- 같은 아이템이 나중에 `approved`가 되면 키가 바뀌어(`:approved:<drive>`) 다시 업로드(한글-only, approved
  폴더). 검수본과 최종본이 각각 남는다.
- per-uploader 실패는 **격리**한다: 그 `(아이템,드라이브)` 키만 미기록으로 남기고 나머지 아이템·드라이브는
  계속 진행. 결과에 `failed` 수를 담아 보고하고, 다음 실행이 미기록 키만 재시도한다.

## 8. 에러/멱등

- Google 4xx/5xx·Lark rate limit → 재시도(shared HttpClient 또는 각 어댑터 재시도). 인증 만료 → 재발급.
- `record`는 각 드라이브 업로드 성공 후에만 → 중복·누락 없이 재개.
- 멱등 키가 **드라이브별**이라, 부분 실패(예: Google 성공·Lark 실패)해도 성공한 Google엔 중복이 안 생기고
  다음 실행이 Lark만 재시도한다.

## 9. 라이브러리 / 스택

- A/B/C와 동일: TypeScript(ESM)·pnpm·Node 24·`zod`·네이티브 `fetch`·`node:crypto`(JWT 서명)·`vitest`·`tsx`.
  **신규 런타임 의존성 없음** (googleapis 미사용).

## 10. 설정 / 시크릿 / 프로비저닝 (Kyle) 📌

`.env`(gitignore) — `.env.example`에 추가:
- Google: `GOOGLE_SA_KEY_FILE`(서비스계정 JSON 경로), `GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`
- Lark: `LARK_DRIVE_REVIEW_FOLDER_TOKEN`, `LARK_DRIVE_APPROVED_FOLDER_TOKEN` (앱 토큰은 B의 `LARK_APP_ID/SECRET` 재사용)

**Kyle 프로비저닝 체크리스트** (가이드 문서 `docs/guides/drive-setup-guide.md` 제공 예정):
1. **Google**: GCP 프로젝트 → Drive API 활성화 → 서비스 계정 생성 → JSON 키 다운로드(`GOOGLE_SA_KEY_FILE`) →
   `GDRIVE_SHARE_EMAILS`(팀 이메일) 설정 → **`pnpm drive:init`**(SA가 review/approved 폴더 생성 + 팀에 편집자
   공유 + 폴더 ID 출력) → 출력 ID를 `.env`(`GDRIVE_*_FOLDER_ID`)에. (scope `drive.file` 최소 권한.)
2. **Lark**: B 앱에 Drive 스코프(`drive:drive`) 추가 + 버전 릴리스 → review/approved 폴더 token 확보.

## 11. 테스트 (TDD)

- 순수: `renderReview`/`renderApproved`/`safeFileName`.
- `GoogleAuth`: fixed RSA 키로 JWT 서명 결정적 검증 + fake로 토큰 캐시/갱신.
- `GoogleDriveUploader`/`LarkDriveUploader`: fake fetch/HttpClient로 요청 형태(멀티파트·폴더·인증헤더·엔드포인트) 검증.
- `JsonPublishStore`: 멱등 키셋 round-trip.
- `PublishTranslations`: fake uploader+store로 review/approved 분기·드라이브별 멱등·부분실패 시 미기록 키만 재시도.
- 라이브 probe: Google/Lark 자격증명 있을 때만 실행, 없으면 skip.

## 12. CLI

- `pnpm drive:publish [--target google|lark|both]` → 미업로드 번역을 대상 드라이브에 업로드. 조립은 `cli/publish.ts`.

## 13. 향후 확장

- 업로드 후 Lark 알림(봇 H). 업로드 이력을 Google Sheet(G)에 기록. §5 변환 결과도 같은 업로더 재사용.
