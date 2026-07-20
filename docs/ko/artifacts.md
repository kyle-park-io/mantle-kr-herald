# 산출물 지도 (artifacts.md)

이 문서는 `mantle-kr-herald` 파이프라인의 모든 명령이 **어떤 파일을 읽고, 어떤 파일을 쓰고, 어떤 외부
시스템을 호출하는지**를 명령 단위로 정리한 참조 문서입니다. 다른 세 개의 한국어 문서
(`capabilities.md`, `quickstart.md`, `team-runbook.md`)는 구체적인 경로·스키마가 필요할 때 이
문서를 인용합니다.

모든 경로는 `src/paths.ts`를 단일 진실 공급원(single source of truth)으로 삼아 저장소 루트
(`REPO_ROOT`)를 기준으로 해석되며, 명령을 어느 디렉터리에서 실행하든 동일합니다.

## 1. 저장 계층

| 계층 | 위치 | 성격 | git |
|---|---|---|---|
| 코드 + 문서 | `src/`, `docs/` | 공개 | 추적됨 |
| 스티어링 **예시** | `translation/*.example.json`, `conversion/*.example.md` | 공개 스켈레톤 | 추적됨 |
| 스티어링 **실제 값** | `translation/`, `conversion/` 안의 실제 파일 | 팀 자산 | **무시됨(ignored)** |
| 작업 공간 | `output/` (`publish/local/` 제외) | 폐기 가능한 중간 산출물 | 무시됨 |
| **기록의 원본** — `cloud` 모드 | Google Drive / Lark Drive | 승인된 결과물, 영구 보존 | — |
| **기록의 원본** — `local` 모드 | `output/publish/local/{review,approved}/` | 승인된 결과물. 무시되는 트리에 있으므로 **백업은 사용자 책임** | 무시됨 |
| 게시 이력 | Google Sheet `history` 탭 | 게시 + 도달 기록 | — |

`local` 모드에서는 `output/`이 통째로 "폐기 가능"하지 않습니다 — `output/publish/local/` 아래의
마크다운은 파이프라인이 만들어내는 **최종 산출물**이며, `pnpm clean`은 이 파일들을 지우지
않습니다(임시 파일 패턴만 청소).

`translation/`, `conversion/` 디렉터리는 `*.example.*` 스켈레톤만 git에 추적되고, 실제 팀 콘텐츠
(`glossary.json`, `style-guide.md`, `locale.json`, `few-shot*.json`, `x.md`/`announcement.md`/`kol.md`/`pr.md`)는
`.gitignore`로 제외됩니다. `pnpm config:init`이 예시 파일을 복사해 실제 파일을 만들어 줍니다
(§3 참고).

## 2. 저장 모드

```bash
HERALD_STORAGE_MODE=local|cloud
```

값은 **추론되지 않고 항상 명시**되어야 합니다. 비어 있거나 `local`/`cloud`가 아니면 두 값을 모두
언급하는 에러와 함께 `pnpm doctor` 실행을 안내하며 즉시 실패합니다
(`src/storage/mode.ts`의 `parseStorageMode`).

**저장 모드를 실제로 읽어서 검사하는 명령은 소수뿐입니다** — 위 네 개 CLI(`drive-init`/
`sheet-init`/`targets-list`/`history-record`), `pnpm doctor`, `pnpm drive:publish`, `pnpm serve`가
전부입니다. `pnpm collect`, `translate:*`, `convert:*`, `format`, `pnpm archive`, `pnpm clean` 등
나머지 명령은 저장 모드를 아예 참조하지 않으므로, 모드가 없거나 잘못돼도 이들에는 애초에 영향이
없습니다. `pnpm status`도 이쪽에 가깝지만 이유가 다릅니다 — 클라우드 명령이 아니라 읽기 전용
진단이므로, `src/cli/status.ts`는 `parseStorageMode`도 `tryParseStorageMode`도 import하지 않고
저장 모드를 전혀 읽지 않은 채 `output/` 아래 로컬 저장소 파일들만 읽어 계산합니다. 그래서 모드가
없거나 잘못 설정돼 있어도 멈추지 않으며, 아래 표처럼 `local`과 `cloud`에서 정확히 동일하게 경고를
표시합니다.

| | `local` | `cloud` |
|---|---|---|
| `collect` → `translate` → `convert` → `format` | 동일하게 동작 | 동일하게 동작 |
| `drive:init`, `sheet:init`, `targets:list`, `history:record` (네 개) | `"<command>: local mode — skipped (set HERALD_STORAGE_MODE=cloud to enable)"`을 출력하고 종료 코드 `0` | 정상 실행 |
| `drive:publish` | `output/publish/local/{review,approved}/`에 마크다운 저장 | Google/Lark Drive에 업로드 |
| `pnpm archive` | 완료된 워크시트만 옮길 뿐 `output/publish/local/`은 건드리지 않습니다 — 그 트리의 백업은 사용자 책임입니다(§1) | Drive가 원본이므로 보조 수단 |
| `pnpm status` | 동기화되지 않은/오래된(stale) 항목이 있으면 `cloud`와 동일하게 `⚠`로 경고 | 동기화되지 않은/오래된(stale) 항목이 있으면 `⚠`로 경고 |
| `pnpm doctor` | 클라우드 자격증명이 없어도 전부 `warn`, 종료 코드 `0` (Storage mode·steering 누락만 `fail`) | **Google auth·Google Drive**(코어 발행 경로)가 없으면 `fail`·종료 코드 `1`. **twitterapi·Lark app·Lark Drive·Google Sheet는 소스/opt-in이라 없어도 `warn`뿐** — Google+X만 쓰는 셋업도 종료 코드 `0` |

스킵은 실패가 아니라 정상 동작이므로 종료 코드는 `0`입니다 — 비영(非零) 종료 코드는 래퍼 스크립트를
깨뜨릴 수 있기 때문입니다. 이 게이트는 네 개 CLI(`drive-init.ts`, `targets-list.ts`,
`history-record.ts`, `sheet-init.ts`)가 공통으로 호출하는
`skipIfLocal()`(`src/cli/skipIfLocal.ts`)로 구현되어 있습니다. `publish.ts`는 이 목록에 없습니다 —
`local` 모드에서도 스킵하지 않고 파일시스템을 대상으로 정상 실행됩니다.

웹 대시보드(`pnpm serve`)의 `POST /api/publish`도 같은 모드를 따르지만, `local` 모드에서도
그대로 게시합니다 — CLI와 동일하게 `resolveTargets()`/`createUploaders()`를 거쳐 로컬 모드에서는
`LocalFileUploader`가 쓰입니다. `GET /api/config`가 프런트엔드에 저장 모드를 알려주므로, 대시보드의
대상 선택지는 그 모드에서 실제로 동작하는 것만 보여주도록 좁혀집니다.
**대시보드 자체는 `local` 모드에서도 그대로 쓸 수 있습니다** — 목록·편집·승인·게시 모두 동작합니다.

승인(approve)은 자동 업로드를 유발하지 않습니다. 게시는 항상 의도적인 사람의 행동입니다.

### local → cloud 승격 절차

1. `.env`에 `HERALD_STORAGE_MODE=cloud`를 설정합니다.
2. Google/Lark 인증 정보를 채웁니다 (`pnpm doctor`로 무엇이 빠졌는지 확인).
3. `pnpm drive:init`으로 Drive 폴더를, `pnpm sheet:init`으로 Google Sheet를 만듭니다(둘 다 아직
   없다면).
4. `pnpm drive:publish`를 실행합니다. `output/publish/state.json`(동기화 원장, §4)에 아직 기록되지
   않은 `output/translations/translations.json`의 모든 항목이 이 한 번의 실행으로 업로드됩니다 —
   즉 `local` 모드에서 쌓인 번역 백로그 전체가 한 번에 동기화됩니다. 원장에 이미 `target: "local"`
   행이 있어도 상관없습니다 — `entryKey()`가 `target`까지 포함해 키를 만들므로 `google`/`lark` 행은
   완전히 별개의 키이고, 승격 시 정상적으로 새로 업로드됩니다.

## 3. 명령어별 입출력

| 명령어 | 읽는 것 | 쓰는 것 | 외부 시스템 |
|---|---|---|---|
| `pnpm collect [target]` | `TWITTERAPI_IO_KEY`(env); 기존 스레드 병합을 위한 `output/x/items.json`; 워터마크 조회를 위한 `output/x/state.json` | `output/x/items.json`(upsert); `output/x/state.json`(워터마크 갱신) | twitterapi.io API |
| `pnpm collect-lark` | `LARK_APP_ID`/`LARK_APP_SECRET`/`LARK_CHAT_IDS`(env); `output/lark/items.json`; 채팅방별 워터마크를 위한 `output/lark/state.json` | `output/lark/items.json`(upsert); `output/lark/state.json` | Lark Open API(테넌트 토큰 발급 + 메시지 조회) |
| `pnpm lark:chats` | `LARK_APP_ID`/`LARK_APP_SECRET`(env) | 없음(표준 출력만) | Lark Open API(봇이 속한 채팅방 목록 조회) |
| `pnpm lark:send` | `LARK_APP_ID`/`LARK_APP_SECRET`(env); `--chat`/`--text` 인자 또는 `LARK_CHAT_IDS`의 첫 값 | 없음 | Lark Open API(메시지 전송) |
| `pnpm reconcile` | `output/x/items.json`(활성 상태 트윗 id 목록) | `output/x/items.json`(삭제가 감지된 스레드만 `status: "deleted"`로 갱신) | twitterapi.io API(id로 트윗 재조회) |
| `pnpm translate:prepare [--source x\|lark] [--ids] [--since] [--limit]` | `output/x/items.json`, `output/lark/items.json`(`--source`로 한쪽만 선택 가능); 이미 번역된 id 제외를 위한 `output/translations/translations.json`; `translation/glossary.json`, `translation/few-shot.json`, `translation/style-guide.md`, `translation/locale.json` | `output/translations/worksheets/`에 `batch-<타임스탬프>.md` 워크시트 생성; `output/translations/pending.json` 갱신(덮어쓰기 전 이전 배치를 `output/archive/<YYYY-MM-DD>/`로 자동 이동) | 없음 |
| `pnpm translate:save --id --file [--approve]` | `output/translations/pending.json`(없으면 `output/translations/translations.json`에서 이미 저장된 항목으로 폴백); `--file`로 지정한 로컬 한글 텍스트 | `output/translations/translations.json`(upsert); `--approve` 시 `translation/few-shot.json`에 예시 추가 | 없음 |
| `pnpm convert:prepare [--ids] [--since] [--limit] [--types]` | 승인된 항목을 위한 `output/translations/translations.json`; 이미 변환된 키 제외를 위한 `output/variants/variants.json`; `translation/glossary.json`, `translation/locale.json`; `conversion/{x,announcement,kol,pr}.md`, `conversion/few-shot.{x,announcement,kol,pr}.json` | `output/variants/worksheets/`에 `batch-<타임스탬프>.md` 워크시트; `output/variants/pending.json` 갱신(이전 배치는 `output/archive/<YYYY-MM-DD>/`로 이동) | 없음 |
| `pnpm convert:save --id --type --file [--approve]` | `output/variants/pending.json`(없으면 `output/variants/variants.json`에서 폴백); `--file` | `output/variants/variants.json`(upsert); `--approve` 시 `conversion/few-shot.<type>.json` | 없음 |
| `pnpm format [--ids] [--types] [--channels] [--refine] [--x-bold unicode]` | 승인된 항목을 위한 `output/variants/variants.json` | 기본 모드: `output/formatted/renderings.json`에 직접 upsert. `--refine` 모드: `output/formatted/worksheets/`에 `batch-<타임스탬프>.md`, `output/formatted/pending.json` 갱신(이전 배치는 `output/archive/<YYYY-MM-DD>/`로 이동) | 없음 |
| `pnpm format:save --id --type --channel --file` | `output/formatted/pending.json`(없으면 `output/formatted/renderings.json`에서 폴백); `--file` | `output/formatted/renderings.json`(upsert, `refined: true`) | 없음 |
| `pnpm glossary [add --term --rule ...]` | `translation/glossary.json` | `add` 서브커맨드일 때만 `translation/glossary.json`(upsert) | 없음 |
| `pnpm config:init` | `translation/*.example.*`, `conversion/*.example.*` | 실제 파일이 아직 없는 것만 생성(`translation/{glossary,locale,style-guide,few-shot}.*`, `conversion/{x,announcement,kol,pr}.md`, `conversion/few-shot.{x,announcement,kol,pr}.json`) — 이미 있으면 절대 덮어쓰지 않음 | 없음 |
| `pnpm drive:publish [--target google\|lark\|local\|both\|<쉼표로 나열>]` | `output/translations/translations.json`; 중복 게시 방지 및 `stale` 판정을 위한 `output/publish/state.json` | `output/publish/state.json`(신규 업로드는 SyncEntry 추가, `stale` 항목은 기존 행을 갱신 — 둘 다 §4); `output/publish/local/{review,approved}/*.md`(`local` 모드, 또는 `--target`에 `local`이 포함된 경우) | 모드/`--target`에 따라 다름 — 없음(`local`만인 경우), 또는 Google Drive API(파일 생성 엔드포인트, 그리고 `stale` 항목에는 파일 갱신 엔드포인트도) 그리고/또는 Lark Drive API(파일 생성 엔드포인트만 — 갱신 엔드포인트 없음, §4) |
| `pnpm drive:init [--force]` | `local` 모드면 스킵. 로컬 파일 없음(env만) | 로컬 파일 없음 — 생성된 폴더 id를 `.env`에 붙여넣도록 콘솔에 출력 | Google Drive API(폴더 생성/공유) |
| `pnpm targets:list [--active-only]` | `local` 모드면 스킵. 로컬 파일 없음 | 없음 | Google Sheets API(`targets` 탭 조회) |
| `pnpm history:record --item --type --channel --status [...]` | `local` 모드면 스킵. 로컬 파일 없음 | 로컬 파일 없음 | Google Sheets API(`history` 탭에 행 추가) |
| `pnpm impressions:record [--since <YYYY-MM-DD>]` | `local` 모드면 스킵. `history` 탭 전체(`history!A2:I`); `channel=x`이고 `postId` 있는 행의 트윗을 `GET /twitter/tweets`로 조회(`--since`면 `publishedAt` ≥ 커트오프만). `TWITTERAPI_IO_KEY`(env) | 각 행의 **H(impressions=viewCount)·I(impressionsAt)** 만 갱신 — A–G는 안 건드림 | twitterapi.io(트윗 조회), Google Sheets(history 갱신) |
| `pnpm sheet:init` | `local` 모드면 스킵. 로컬 파일 없음 | 로컬 파일 없음 — 생성된 스프레드시트 id를 콘솔에 출력 | Google Sheets API(스프레드시트 + `targets`/`history` 탭 생성) |
| `pnpm doctor [--live]` | 모든 env 설정 로더; `translation/glossary.json`, `translation/style-guide.md`, `translation/locale.json`, `conversion/x.md`의 존재 여부(4개 파일만 확인) | 없음 | `--live`일 때만: Google OAuth tokeninfo, Google Drive/Sheets 파일 메타데이터 조회, Lark 인증 + 채팅 목록 조회 |
| `pnpm status` | `output/x/items.json`, `output/lark/items.json`, `output/translations/translations.json`, `output/variants/variants.json`, `output/formatted/renderings.json`, `output/publish/state.json` | 없음 | 없음 |
| `pnpm archive` | `output/translations/worksheets/`, `output/variants/worksheets/`, `output/formatted/worksheets/`의 `.md` 목록 | 대상 파일들을 `output/archive/<YYYY-MM-DD>/`로 이동 | 없음 |
| `pnpm clean [--older-than <days>] [--yes]` | `output/archive/`의 날짜 폴더 목록; 좌초된 임시 파일 탐지를 위해 `output/` 전체(`output/archive/` 내부는 제외)를 재귀 탐색 | 기본은 드라이런(삭제 대상만 출력). `--yes`일 때: 30일(기본값) 초과 경과한 `output/archive/<YYYY-MM-DD>/` 폴더 + `output/archive/`를 제외한 `output/` 안 어디에 있든 `*.tmp-<pid>-<ms>-<uuid>` 형식의 좌초 파일을 삭제 | 없음 |
| `pnpm serve` | 대시보드 API를 통해 `output/translations/translations.json`, `output/variants/variants.json`, `output/formatted/renderings.json`, `output/publish/state.json` | 저장/승인/포맷 저장/게시 API 호출 시 위와 동일한 파일들; `local` 모드에서 게시하면 `output/publish/local/{review,approved}/*.md`도 포함(§2 참고) | 게시 API 호출 시 모드에 따라 Google Drive API, Lark Drive API(`cloud`), 또는 없음(`local`) |
| `pnpm google:auth` | `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`/`GOOGLE_OAUTH_SCOPE`(env) | 로컬 파일 없음 — refresh token을 콘솔에 출력 | Google OAuth 2.0(로컬 루프백 서버로 인가 코드 교환) |

## 4. 동기화 원장

`output/publish/state.json`은 단순 게시 여부 집합이 아니라, **`(itemId, status, target)` 조합마다
한 행**을 갖는 원장(ledger)입니다(`src/domain/publish/syncLedger.ts`의 `SyncEntry`).

```ts
interface SyncEntry {
  itemId: string;
  stage: "translation";
  status: string;       // 게시 시점의 번역 status ("translated" | "approved")
  target: string;        // 업로드 대상 — "google" | "lark" | "local"
  fileName?: string;
  remoteId?: string;
  url?: string;
  contentHash?: string;  // 업로드된 실제 바이트에 대한 sha256
  uploadedAt?: string;
}
```

실제 파일 예시:

```jsonc
{
  "entries": [
    {
      "itemId": "x:1934567890123456789",
      "stage": "translation",
      "status": "approved",
      "target": "google",
      "fileName": "2026-07-20-mantle-공식-업데이트-x-1934567890123456789.md",
      "remoteId": "1AbCDeFgHiJkLmNoPqRsTuVwXyZ",
      "url": "https://drive.google.com/file/d/1AbCDeFgHiJkLmNoPqRsTuVwXyZ/view",
      "contentHash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "uploadedAt": "2026-07-20T05:12:00.000Z"
    }
  ]
}
```

행을 식별하는 키는 `entryKey()`가 `${itemId}:${status}:${target}`를 그대로 이어붙여 만듭니다.
`itemId`는 `x:`나 `lark:` 접두어 자체에 콜론을 포함하므로, 반대로 레거시 키 문자열을 다시 세 값으로
되돌려야 하는 `migrateLegacyKeys()`(아래 '레거시 마이그레이션' 참고)는 이 콜론 때문에 오른쪽부터
파싱합니다.

**`contentHash`가 감지하는 것:** `pnpm drive:publish`는 업로드 직전 렌더링한 바이트에 대해
`contentHash()`(sha256)를 계산해 저장합니다. `pnpm status`는 현재 번역 내용을 같은 방식으로
다시 렌더링·해시해 원장의 값과 비교해 보여 주기만 하지만, `pnpm drive:publish` 자신도 실행할
때마다 같은 비교를 해서 값이 다르면(`isStale`) **재업로드 여부를 스스로 결정**합니다 — 즉
`contentHash`는 `pnpm status`용 보고 값일 뿐 아니라 재게시를 트리거하는 값이기도 합니다
(`src/status/sync.ts`의 `syncSummary`, `src/domain/publish/syncLedger.ts`의 `isStale`,
`src/app/PublishTranslations.ts`).

`stale`로 판정된 행은 대상이 Google 또는 `local`이면 기존 파일을 그 자리에서 갱신하고(중복 없음),
대상이 Lark면 갱신 엔드포인트가 없어 실패로 보고됩니다. Google은 파일 id·공유 링크를 유지한 채
PATCH하고, `local`(`LocalFileUploader.update`)은 새 내용을 다시 쓴 뒤 파일명이 바뀌었으면(예:
재승인으로 `approvedAt` 날짜가 바뀐 경우) 이전 파일을 지워 하나만 남깁니다. Lark만 갱신 수단이
없는 이유는 Lark Drive `drive/v1`에 콘텐츠를 그 자리에서 바꾸는 API가 없기 때문이며, 이 항목은
Drive에서 직접 찾아 수동으로 처리해야 합니다.

**레거시 마이그레이션:** 예전 형식 `{"published": ["<itemId>:<status>:<target>", ...]}`은 읽는
시점에 자동 변환됩니다(`migrateLegacyKeys`). 이 경로로 만들어진 행은 `stage: "translation"`과
`itemId`/`status`/`target`만 채워지고, `fileName`/`remoteId`/`url`/`contentHash`/`uploadedAt`은
비워 둡니다 — 실제로 알 수 없는 값이기 때문에, 자리채움 값을 넣으면 진짜 업로드 기록과 구별할 수
없어지는 것을 피하기 위함입니다. 변환은 읽을 때마다 메모리에서 일어나며, `output/publish/state.json`
자체가 새 형식으로 다시 쓰이는 것은 다음 번 `record()` 호출(예: 다음 `pnpm drive:publish` 실행)
때입니다. `contentHash`가 없는 이 행들은 `isStale`이 "모름"을 "변경 없음"으로 취급하므로
`stale`로 보고되지도, 재업로드되지도 않습니다. **이 상태는 영구적입니다** — 원장에 행이 있으면
`PublishTranslations`는 `contentHash` 비교 없이 그 자리에서 건너뛰고 `record()`를 다시 호출하지
않으므로, 이런 행은 그 항목이 나중에 다시 게시되더라도 `contentHash`를 얻지 못합니다. 유일한
탈출 경로(레거시 행 전용, 원장 행 수동 삭제 + 재게시)와 자동 갱신 경로(해시가 있는 `stale` 행
전용, Google과 `local`만)를 서로 다른 상황에만 써야 하며, 두 절차를 구분해 정리한 문서는
[`team-runbook.md`](team-runbook.md) §4를 참고하세요.

## 5. 보존 정책

`output/archive/<YYYY-MM-DD>/`는 두 가지를 자동/수동으로 받습니다.

1. **대체된 `pending.json` 배치** — `pnpm translate:prepare`, `pnpm convert:prepare`,
   `pnpm format --refine`가 새 배치로 덮어쓰기 직전 이전 `pending.json`을 무조건, `local`/`cloud`
   두 모드 모두에서 이동시킵니다(`archiveFile()`). 저장하지 않은 배치를 잃지 않도록 하는 안전망입니다.
2. **완료된 워크시트** — `pnpm archive`가 `output/{translations,variants,formatted}/worksheets/`의
   `.md` 파일들을 이동시킵니다. 재실행하면 다시 생성할 수 있는 산출물이므로 자동이 아니라 수동
   명령으로 처리합니다.

`pnpm clean [--older-than <days>] [--yes]`:

- 기본 보존 기간은 **30일**이며 `--older-than`으로 바꿀 수 있습니다. 경계는 **엄격히 초과(strictly
  greater)** — 정확히 N일 된 폴더는 아직 삭제 대상이 아닙니다(`expiredArchiveDays`).
- 만료된 `output/archive/<YYYY-MM-DD>/` 폴더와, 중단된 원자적 쓰기가 남긴 좌초 임시 파일
  (`*.tmp-<pid>-<ms>-<uuid>`, `output/archive/` 내부를 제외한 `output/` 전체를 재귀 탐색해 탐지)을
  삭제 대상으로 삼습니다. (`output/archive/`는 위 항목에서 폴더 단위로 이미 다뤄지므로 내부까지
  다시 훑지 않습니다.)
- 기본은 **드라이런**입니다 — 무엇을 지울지 목록만 출력합니다. 실제 삭제는 `--yes`를 붙여야
  일어납니다.
- 살아 있는 저장소(store) 파일은 절대 건드리지 않습니다. 대상은 만료된 아카이브 폴더와 임시 파일
  패턴에 정확히 일치하는 파일뿐입니다.

## 6. 잃으면 안 되는 것 vs 지워도 되는 것

**잃으면 안 되는 것 (사람의 노동이 담긴 산출물 · 재생성 불가):**

- `output/translations/translations.json` — 사람이 손으로 번역한 한글 원문
- `output/variants/variants.json` — 채널별 변환 결과
- `output/formatted/renderings.json` — 채널별 최종 포맷 렌더링
- 실제 스티어링 파일: `translation/glossary.json`, `translation/style-guide.md`,
  `translation/locale.json`, `translation/few-shot.json`, `conversion/{x,announcement,kol,pr}.md`,
  `conversion/few-shot.{x,announcement,kol,pr}.json`
- `output/x/state.json`, `output/lark/state.json` — 수집 워터마크. 잃으면 에러 없이 조용히 재수집
  구간이 비게 됩니다.

**지워도 되는 것 (재생성 가능하거나 이미 다른 곳에 보존됨):**

- 이미 `pnpm archive`로 옮긴 뒤의 워크시트 원본(`output/{translations,variants,formatted}/worksheets/*.md`) — `prepare`를 다시 실행하면 재생성됩니다
- `output/publish/local/{review,approved}/*.md` — `translations.json`에서 파생된 발행본이라 원리상 재생성 가능하지만, 동기화 원장(`output/publish/state.json`)에 기록이 남아 있으면 `drive:publish`가 스킵하므로 **다시 만들려면 해당 원장 행을 지우고 재발행**해야 합니다. `local` 모드에선 이게 공유용 최종본(§1의 기록의 원본)이므로 백업을 권장합니다
- 보존 기간이 지난 `output/archive/<YYYY-MM-DD>/` 폴더
- `*.tmp-*` 임시 파일 — 중단된 원자적 쓰기의 잔재
- `output/x/items.json`, `output/lark/items.json` — twitterapi.io / Lark에서 다시 수집할 수
  있습니다 (단, 재수집은 워터마크 이후 구간만 가져오므로 워터마크가 함께 없을 때만 완전한
  재수집이 됩니다)

## 7. 알려진 마찰

다음 두 가지 이름 불일치는 **의도적으로 그대로 둔 것**입니다.

- `output/formatted/renderings.json`과 `output/publish/state.json`은 디렉터리 이름과 파일 이름이
  일치하지 않습니다 (`formatted/` 안의 파일은 `renderings.json`이지 `formatted.json`이 아니고,
  `publish/` 안의 파일은 `state.json`입니다).
- `state.json`이라는 같은 파일 이름이 두 가지 다른 스키마를 가리킵니다: `output/x/state.json`,
  `output/lark/state.json`에서는 **워터마크 맵**(`{"watermarks": {...}}`)을 의미하지만,
  `output/publish/state.json`에서는 **동기화 원장**(`{"entries": [...]}`, §4)을 의미합니다.

이름을 통일하는 리팩터는 기존 로컬 데이터를 함께 마이그레이션해야 하는데, 기능상 얻는 것이 없어
범위 밖으로 남겨 두었습니다.
