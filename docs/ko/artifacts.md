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
(`glossary.json`, `style-guide.md`, `locale.json`, `tm.json`, `few-shot*.json`, 타입별 `conversion/<타입>.md`)는
`.gitignore`로 제외됩니다. `pnpm config:init`이 예시 파일을 복사해 실제 파일을 만들어 줍니다
(§3 참고).

### 이름 규칙 — 루트는 프로세스, `output/`은 산출물

디렉터리 이름은 두 가지 규칙을 따릅니다.

- **저장소 루트의 스티어링 디렉터리 = 프로세스 이름** — `translation/`, `conversion/`
- **`output/` 아래 디렉터리 = 그 단계가 만들어낸 산출물 이름** — `translations/`, `variants/`,
  `formatted/`

| 단계 | 도메인 코드 | 스티어링(루트) | CLI | `output/` 디렉터리 | 산출 파일 |
|---|---|---|---|---|---|
| 번역 | `src/domain/translation` | `translation/` | `translate:*` | `translations/` | `translations.json` |
| 변환 | `src/domain/conversion` | `conversion/` | `convert:*` | `variants/` | `variants.json` |
| 포맷 | `src/domain/formatting` | (없음) | `format` | `formatted/` | `renderings.json` |

루트의 `conversion/`과 `output/variants/`가 짝이 안 맞는 것처럼 보이지만 규칙이 깨진 것은
아닙니다 — 변환 단계는 **프로세스**가 conversion, **산출물**이 variant라서 두 단어가 갈릴 뿐입니다.
번역 단계만 프로세스와 산출물이 우연히 같은 단어(translation)를 쓰기 때문에 그쪽이 "짝이 맞는
이름"처럼 보이는 것이고, 이것이 나머지를 불일치로 오해하게 만드는 원인입니다. 포맷 단계는
스티어링 설정이 없어 루트 디렉터리 자체가 없습니다(산출물 이름 불일치는 §7 참고).

## 2. 저장 모드

```bash
HERALD_STORAGE_MODE=local|cloud
```

값은 **추론되지 않고 항상 명시**되어야 합니다. 비어 있거나 `local`/`cloud`가 아니면 두 값을 모두
언급하는 에러와 함께 `pnpm doctor` 실행을 안내하며 즉시 실패합니다
(`src/storage/mode.ts`의 `parseStorageMode`).

**저장 모드를 실제로 읽어서 검사하는 명령은 소수뿐입니다** — 위 일곱 개 CLI(`drive:init`/
`sheet:init`/`targets:list`/`history:record`/`impressions:record`/`metrics:record`/
`kol-telegram:record`), `pnpm doctor`, `pnpm drive:publish`, `pnpm serve`가 전부입니다.
`pnpm collect`, `collect:reference`, `tm:*`,
`translate:*`, `convert:*`, `format`, `pnpm send:channels`, `pnpm archive`, `pnpm clean` 등 나머지
명령은 저장 모드를 아예 참조하지 않으므로(참고 계정 수집·번역 메모리 명령과 마찬가지로
`send:channels`도 어느 모드에서든 동일하게 동작합니다 — 필요한 것은 텔레그램/Typefully 자체
토큰뿐입니다), 모드가 없거나 잘못돼도 이들에는 애초에 영향이 없습니다. `pnpm status`도 이쪽에 가깝지만 이유가 다릅니다 — 클라우드 명령이 아니라 읽기 전용
진단이므로, `src/cli/status.ts`는 `parseStorageMode`도 `tryParseStorageMode`도 import하지 않고
저장 모드를 전혀 읽지 않은 채 `output/` 아래 로컬 저장소 파일들만 읽어 계산합니다. 그래서 모드가
없거나 잘못 설정돼 있어도 멈추지 않으며, 아래 표처럼 `local`과 `cloud`에서 정확히 동일하게 경고를
표시합니다.

| | `local` | `cloud` |
|---|---|---|
| `collect` → `translate` → `convert` → `format` | 동일하게 동작 | 동일하게 동작 |
| `drive:init`, `sheet:init`, `targets:list`, `history:record`, `impressions:record`, `metrics:record`, `kol-telegram:record` (일곱 개) | `"<command>: local mode — skipped (set HERALD_STORAGE_MODE=cloud to enable)"`을 출력하고 종료 코드 `0` | 정상 실행 |
| `drive:publish` | `output/publish/local/{review,approved}/`에 마크다운 저장 | Google/Lark Drive에 업로드 |
| `pnpm archive` | 완료된 워크시트만 옮길 뿐 `output/publish/local/`은 건드리지 않습니다 — 그 트리의 백업은 사용자 책임입니다(§1) | Drive가 원본이므로 보조 수단 |
| `pnpm status` | 동기화되지 않은/오래된(stale) 항목이 있으면 `cloud`와 동일하게 `⚠`로 경고 | 동기화되지 않은/오래된(stale) 항목이 있으면 `⚠`로 경고 |
| `pnpm doctor` | 클라우드 자격증명이 없어도 전부 `warn`, 종료 코드 `0` (Storage mode·steering 누락만 `fail`) | **Google auth·Google Drive**(코어 발행 경로)가 없으면 `fail`·종료 코드 `1`. **twitterapi·Lark app·Lark Drive·Google Sheet는 소스/opt-in이라 없어도 `warn`뿐** — Google+X만 쓰는 셋업도 종료 코드 `0` |

스킵은 실패가 아니라 정상 동작이므로 종료 코드는 `0`입니다 — 비영(非零) 종료 코드는 래퍼 스크립트를
깨뜨릴 수 있기 때문입니다. 이 게이트는 위 일곱 개 CLI가 공통으로 호출하는
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
| `pnpm collect [target] [--since <3d\|12h\|1w\|ISO>] [--limit <n>]` | `TWITTERAPI_IO_KEY`(env); 기존 스레드 병합을 위한 `output/x/items.json`; 워터마크 조회를 위한 `output/x/state.json`(`--since`가 있으면 워터마크 대신 그 값을 floor로 사용) | `output/x/items.json`(upsert); `output/x/runs.json`(append — 실행마다 커버리지 레코드 1건 기록); `output/x/state.json`(워터마크 갱신 — `--since`/`--limit` 중 하나라도 주면 ad-hoc 실행이라 갱신하지 않고, 플래그 없는 실행만 갱신) | twitterapi.io API |
| `pnpm collect-lark` | `LARK_APP_ID`/`LARK_APP_SECRET`/`LARK_CHAT_IDS`(env); `output/lark/items.json`; 채팅방별 워터마크를 위한 `output/lark/state.json` | `output/lark/items.json`(upsert); `output/lark/state.json` | Lark Open API(테넌트 토큰 발급 + 메시지 조회) |
| `pnpm lark:chats` | `LARK_APP_ID`/`LARK_APP_SECRET`(env) | 없음(표준 출력만) | Lark Open API(봇이 속한 채팅방 목록 조회) |
| `pnpm lark:send` | `LARK_APP_ID`/`LARK_APP_SECRET`(env); `--chat`/`--text` 인자 또는 `LARK_CHAT_IDS`의 첫 값 | 없음 | Lark Open API(메시지 전송) |
| `pnpm reconcile` | `output/x/items.json`(활성 상태 트윗 id 목록) | `output/x/items.json`(삭제가 감지된 스레드만 `status: "deleted"`로 갱신) | twitterapi.io API(id로 트윗 재조회) |
| `pnpm translate:prepare [--source x\|lark] [--ids] [--since] [--limit]` | `output/x/items.json`, `output/lark/items.json`(`--source`로 한쪽만 선택 가능); 이미 번역된 id 제외를 위한 `output/translations/translations.json`; `translation/glossary.json`, `translation/few-shot.json`, `translation/tm.json`(번역 메모리 — 큐레이션 few-shot에 더해 이 배치에 관련도 높은 쌍만 골라 인라인), `translation/style-guide.md`, `translation/locale.json` | `output/translations/worksheets/`에 `batch-<타임스탬프>.md` 워크시트 생성; `output/translations/pending.json` 갱신(덮어쓰기 전 이전 배치를 `output/archive/<YYYY-MM-DD>/`로 자동 이동) | 없음 |
| `pnpm translate:save --id --file [--approve]` | `output/translations/pending.json`(없으면 `output/translations/translations.json`에서 이미 저장된 항목으로 폴백); `--file`로 지정한 로컬 한글 텍스트 | `output/translations/translations.json`(upsert); `--approve` 시 `translation/few-shot.json`에 예시 추가(원문이 너무 길면 승격 생략) | 없음 |
| `pnpm translate:align [--ids] [--since] [--limit]` | `output/translations/translations.json`(번역된 초안 — `status: "translated"`인 항목만); `translation/tm.json`(번역 메모리 — 승격된 EN↔KO 쌍 중 초안별로 앵커가 겹치는 선례(precedent)만 골라 인라인) | `output/translations/worksheets/`에 `align-<타임스탬프>.md` 정렬(align) 워크시트 생성(선례가 있는 초안만 포함 — 선례 없는 초안은 건너뛰고 skip 카운트에 반영) | 없음 |
| `pnpm translate:check [--status <s>] [--since <ISO>] [--published]` | 번역 원장 `output/translations/translations.json`(`--status`/`--since`로 필터링 가능); `translation/glossary.json`(용어집 — 비어 있으면 모든 검사가 무의미하게 통과해 버리므로, 실행 자체를 거부하고 대신 에러로 멈춤). 기본은 각 행의 초안을 검사하고, `--published`면 실제 발행 원문이 채워진 행만 골라 그 원문을 검사(원문이 없는 행은 건너뛰고 몇 건 건너뛰었는지 함께 보고) | 없음 — 표준 출력만(용어집 드리프트 목록과, `--published` 여부와 무관하게 항상 함께 나오는 오버라이드 목록). 읽기 전용이라 드리프트나 오버라이드가 나와도 종료 코드는 그대로 `0` | 없음 |
| `pnpm collect:reference [target] [--since <3d\|12h\|1w\|ISO>] [--limit <n>]` | `TWITTERAPI_IO_KEY`(env); 참고 계정 핸들 `REFERENCE_X_HANDLE`(env, 기본 `0xMantleKR`); 기존 스레드 병합을 위한 `output/x/reference/items.json`; 워터마크 조회를 위한 `output/x/reference/state.json` | `output/x/reference/{items,state,runs}.json`(`collect`과 동일한 엔진, **소스 스토어(`output/x/`)와 격리** — 한국어 완성본이 번역 큐에 절대 안 섞임) | twitterapi.io API |
| `pnpm tm:measure [target]` | `TWITTERAPI_IO_KEY`(env); `REFERENCE_X_HANDLE`(env, 기본 `0xMantleKR`) | 없음(표준 출력만 — 계정 게시물 수 + 백필 예상 비용) | twitterapi.io API(`GET /twitter/user/info`) |
| `pnpm tm:pair` | `output/x/items.json`(Mantle_Official 영어) + `output/x/reference/items.json`(참고 계정 한국어) | `output/x/reference/pairs-proposed.json`(제안 쌍 — 사람이 `accept`를 `false`로 편집해 거절); `output/x/reference/pairs-review.md`(사람이 눈으로 검토) | 없음(오프라인 — `$MNT`/`#`/`@` 앵커 + 시간창으로 EN↔KO 쌍 제안) |
| `pnpm tm:promote` | `output/x/reference/pairs-proposed.json`(`accept !== false`인 쌍만) | `translation/tm.json`(upsert — 번역 메모리; `translate:prepare`가 읽음) | 없음 |
| `pnpm convert:prepare [--ids] [--since] [--limit] [--types]` | 승인된 항목을 위한 `output/translations/translations.json`; 이미 변환된 키 제외를 위한 `output/variants/variants.json`; `translation/glossary.json`, `translation/locale.json`; `conversion/{x,announcement,kol,pr}.md`, `conversion/few-shot.{x,announcement,kol,pr}.json` | `output/variants/worksheets/`에 `batch-<타임스탬프>.md` 워크시트; `output/variants/pending.json` 갱신(이전 배치는 `output/archive/<YYYY-MM-DD>/`로 이동) | 없음 |
| `pnpm convert:save --id --type --file` | `output/variants/pending.json`(없으면 `output/variants/variants.json`에서 폴백); `--file` | `output/variants/variants.json`(upsert, 항상 `converted` — 승인은 2차 검수에서) | 없음 |
| `pnpm convert:tick` | `HERALD_CONVERT_BATCH`(env, 기본 1). 스스로는 아무것도 읽지 않고 `pnpm convert:prepare --limit N` → (준비된 게 있을 때만) `claude -p` → `pnpm status`(전후 2회) → `pnpm format --only-missing`(**매번**, 준비된 게 없어도)을 하위 프로세스로 실행합니다 — 각 단계가 읽는 것은 그 단계의 행을 보세요 | 준비된 게 없으면 워크시트도 `pending.json`도 쓰지 않습니다. 있으면 `convert:prepare`/에이전트의 `convert:save`가 쓰는 것과 동일 — `output/variants/worksheets/`의 워크시트, `output/variants/pending.json`, `output/variants/variants.json`. 그리고 마지막 단계가 **아직 렌더링이 없는** (항목·유형·채널)만 골라 `output/formatted/renderings.json`에 씁니다 — **이미 있는 렌더링은 절대 건드리지 않습니다**(2차 검수에서 고친 글과 승인 상태가 그대로 남습니다). 에이전트가 넘겨받은 수보다 적게 저장하면 tick이 **실패**합니다 | `claude -p`(로컬 Claude Code CLI). 변환본은 `rendered`(2차 검수 대기)에서 멈추며 X·텔레그램·Typefully·Drive로는 아무것도 나가지 않습니다 |
| `pnpm format [--ids] [--types] [--channels] [--only-missing] [--refine]` | `output/variants/variants.json`(상태 무관 — 변환본 승인 게이트는 없습니다). `--only-missing`이면 기존 렌더링 키(`output/formatted/renderings.json`)도 읽습니다 | 기본 모드: `output/formatted/renderings.json`에 canonical 텍스트(`**볼드**`, `[텍스트](URL)`, 빈 줄 하나 = 문단 구분, 빈 줄 두 개 = 트윗 경계)로 직접 upsert — 입력의 `---` 한 줄도 경계로 인식하지만 저장되는 값은 항상 빈 줄 두 개입니다. **기본 모드는 덮어씁니다**: 고른 (항목·유형·채널)의 기존 글과 승인 상태가 사라지고 `rendered`로 되돌아갑니다(대시보드 `포맷 다시`와 같은 동작). `--only-missing`이면 아직 렌더링이 없는 짝만 만들고 기존 것은 그대로 둡니다 — 스케줄러(`convert:tick`)가 쓰는 모드이며, `--refine`과는 같이 못 씁니다. `--refine` 모드: `output/formatted/worksheets/`에 `batch-<타임스탬프>.md`(채널 제약 + 초안에 등장한 용어집 + 세그먼트별 길이 리포트 포함), `output/formatted/pending.json` 갱신(이전 배치는 `output/archive/<YYYY-MM-DD>/`로 이동) | 없음 |
| `pnpm format:save --id --type --channel --file` | `output/formatted/pending.json`(없으면 `output/formatted/renderings.json`에서 폴백); `--file`(canonical 텍스트) | `output/formatted/renderings.json`(upsert, `refined: true`, canonical 텍스트 그대로 저장) | 없음 |
| `pnpm glossary [add --term --rule ...]` | `translation/glossary.json` | `add` 서브커맨드일 때만 `translation/glossary.json`(upsert) | 없음 |
| `pnpm config:init` | `translation/*.example.*`, `conversion/*.example.*` | 실제 파일이 아직 없는 것만 생성(`translation/{glossary,locale,style-guide,few-shot}.*`, `conversion/{x,announcement,kol,pr}.md`, `conversion/few-shot.{x,announcement,kol,pr}.json`) — 이미 있으면 절대 덮어쓰지 않음 | 없음 |
| `pnpm drive:publish [--target google\|lark\|local\|both\|<쉼표로 나열>]` | `output/translations/translations.json`; 중복 게시 방지 및 `stale` 판정을 위한 `output/publish/state.json` | `output/publish/state.json`(신규 업로드는 SyncEntry 추가, `stale` 항목은 기존 행을 갱신 — 둘 다 §4); `output/publish/local/{review,approved}/*.md`(`local` 모드, 또는 `--target`에 `local`이 포함된 경우) | 모드/`--target`에 따라 다름 — 없음(`local`만인 경우), 또는 Google Drive API(파일 생성 엔드포인트, 그리고 `stale` 항목에는 파일 갱신 엔드포인트도) 그리고/또는 Lark Drive API(파일 생성 엔드포인트, 그리고 `stale` 항목에는 삭제 엔드포인트도 — 콘텐츠 교체 엔드포인트가 없어 새로 올린 뒤 예전 파일을 지우는 방식, §4) |
| `pnpm send:channels [--target telegram\|x\|both] [--ids <id1,id2,...>] [--outlets <방 id 쉼표 나열>]` | 승인된 채널 렌더링을 위한 `output/formatted/renderings.json`(`status: "approved"`이고 채널이 `telegram`/`x`인 행만); 이미 보낸 것 제외를 위한 `output/publish/deliveries.json`(없으면 예전 `output/publish/channels.json`을 **읽기 전용**으로 이관해 사용 — 채널 → 그 채널의 대표 방, 원본은 수정·삭제하지 않음; `status: "dropped"` 행은 이 제외 대상에서 빠져 다시 발송 대상이 됨 — [`capabilities.md`](capabilities.md) §8 참고); `--target`으로 요청한 채널에 따라 `TELEGRAM_BOT_TOKEN` + 방별 `TELEGRAM_CHAT_ID_COMMUNITY`/`TELEGRAM_CHAT_ID_DEV` 또는 `TYPEFULLY_API_KEY`/`TYPEFULLY_SOCIAL_SET_ID`(X, env) | `output/publish/deliveries.json`(upsert, `(itemId, type, outletId)`별 1행 — **채널이 아니라 방 단위**라 한 채널의 두 방이 각각 남습니다; 이 파일이 없어지면 다음 실행이 이미 보낸 메시지를 실제로 다시 보냅니다, 단순 재업로드가 아님); `cloud` 모드에서 `GSHEET_ID`/Google 인증이 있으면 `history` 탭에도 best-effort로 기록(`(itemId, type, outletId)`별 1행, 방 id는 J열; 실패해도 발송은 취소되지 않고 경고만 남김) | Telegram Bot API(`sendMessage`), Typefully API(v2 draft 생성+발행+폴링); 기록 시 Google Sheets API. **`local` 모드에서도 스킵되지 않습니다 — 위 일곱 개 CLI의 `skipIfLocal` 대상이 아닙니다.** |
| `pnpm send:x-article [--ids <id1,id2,...>]` | 승인된 X 아티클 번역을 위한 `output/translations/translations.json`(`status: "approved"`이고, `output/x/items.json`에서 본문 블록이 있는 X Article로 판별되는 항목만 — 일반 트윗은 대상이 아님); 아티클 판별·커버 이미지 url 조회를 위한 `output/x/items.json`; 이미 보낸 것 제외를 위한 `output/publish/x-article.json`(`droppedAt`이 찍힌 행은 이 제외 대상에서 빠져 다시 발송 대상이 됨 — `send:channels`의 `dropped` 예외와 같은 이유, [`capabilities.md`](capabilities.md) §8 참고); 월간 발행 쿼터 계산을 위해 `output/publish/deliveries.json`도 함께 읽음(X 방 발송과 헤드룸을 공유); `TYPEFULLY_API_KEY`/`TYPEFULLY_SOCIAL_SET_ID`(env) | `output/publish/x-article.json`(upsert, `itemId`별 1행 — `postId`/`url`/`sentAt`; 이 파일이 없어지면 다음 실행이 이미 보낸 아티클을 실제로 다시 보냅니다) | Typefully API(이미지 업로드 + article draft 생성+발행) |
| `pnpm send:reconcile` | `output/publish/deliveries.json`과 `output/publish/x-article.json`에서 **예약만 걸리고 아직 게시되지 않은 행**(X 방이면서 `x.com` url이 없고 `postId`(Typefully 초안 id)가 있는 행); `TYPEFULLY_API_KEY`/`TYPEFULLY_SOCIAL_SET_ID`(env) | 같은 두 원장을 제자리 갱신. 초안이 **게시됐으면** 그 행의 `postId`를 실제 X id로, `url`을 `x.com` 주소로 덮어씀(이때부터 §9b 노출수 집계가 붙습니다). 초안이 **404로 사라졌으면** 그 행을 물러나게 함 — 발송 원장은 `status: "dropped"`, 아티클 원장은 `droppedAt`(둘 다 `postId`와 발송 시각은 보존). **물러난 행은 그 방을 다시 발송 대상으로 만들고**, 잡혀 있던 월간 발행 쿼터 한 칸도 풉니다. 그 외(아직 예약 중, 5xx, 요청 실패)는 아무것도 바꾸지 않음 | Typefully API(v2 draft 조회). `pnpm serve`가 떠 있으면 같은 동작이 **2분마다 자동으로** 돌고, 보드의 `게시 확인` 버튼도 이 경로를 부릅니다 |
| `pnpm x:reconcile [--since] [--handle] [--yes]` | `REFERENCE_X_HANDLE`(env, 기본 `0xMantleKR`) 또는 `--handle`; `TWITTERAPI_IO_KEY`(env, 계정의 live 트윗을 스레드 단위로 재구성); 승인된 `x` 렌더링을 위한 `output/formatted/renderings.json`; 중복 방지를 위한 `output/publish/deliveries.json`(딜리버리 키); Google Sheet `history` 탭(A열 `itemId`·D열 `postId` — 이미 기록된 게시물 식별용, 탭이 아직 없으면 빈 것으로 취급); 번역 원장 `output/translations/translations.json`(`source: "x"`인 행만) | `--yes`일 때만: `output/publish/deliveries.json`에 확정된 항목의 `x-post` 아웃렛 `sent` 행 추가; Google Sheet `history` 탭에 파이프라인 밖 글 + 손-게시로 게시됨 처리된 글을 각각 한 행씩 upsert; 번역 원장 `output/translations/translations.json` — 손-게시로 확인된 번역의 `status`를 `posted`로, `postedUrl`/`postedAt`을 채움(한 번 채워지면 절대 덮어쓰지 않음), **그렇게 게시됨으로 남은 항목 중 이 실행의 `--since` 창에 아직 걸리는 것은 실제 발행 원문도 함께 채움(역시 빈 값만 채우고 절대 덮어쓰지 않음)**; 한 번의 실행에서 3건 이상을 게시됨으로 못박으면 텔레그램 알림(`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID_OPS`, 둘 중 하나라도 없으면 조용히 건너뜀). `--yes` 없으면 위 어느 것도 쓰지 않고 계획(확정/후보/외부/게시됨/캡처할 원문 건수)만 출력 | twitterapi.io API(계정 타임라인 재조회), Google Sheets API(`history` 탭 조회+기록) |
| `pnpm x:link --item <itemId> --post <id\|url> [--handle] [--yes]` | `REFERENCE_X_HANDLE`(env, 기본 `0xMantleKR`) 또는 `--handle`; `TWITTERAPI_IO_KEY`(env, **ID로 직접 조회** — 계정 목록 조회를 쓰지 않는 것이 이 명령의 요점); Google Sheet `history` 탭(D열 `postId` — 같은 게시물에 두 번째 행을 만들지 않기 위한 가드); 번역 원장(`source: "x"`인 행만) | `--yes`일 때만: 지정한 번역의 `status`를 `posted`로, `postedUrl`/`postedAt`을 채우고, Google Sheet `history` 탭에 한 행 upsert, 실제 발행 원문을 `published_text`에 채움(빈 값만, 절대 덮어쓰지 않음). `--yes` 없으면 아무것도 쓰지 않고 대상·시각·유사도만 출력. **승인하지 않고, 발송하지 않고, X에 아무것도 쓰지 않으며, 수집 워터마크도 건드리지 않습니다.** 유사도가 낮으면 경고만 하고 막지는 않습니다 — 이 명령은 매칭기가 못 본 글을 사람이 지정하는 자리라, 기계 점수가 사람을 막으면 존재 이유가 사라집니다 | twitterapi.io API(게시물 ID 조회 + 스레드 문맥), Google Sheets API(`history` 탭 조회+기록) |
| `pnpm drive:init [--force]` | `local` 모드면 스킵. 로컬 파일 없음(env만) | 로컬 파일 없음 — 생성된 폴더 id를 `.env`에 붙여넣도록 콘솔에 출력 | Google Drive API(폴더 생성/공유) |
| `pnpm targets:list [--active-only]` | `local` 모드면 스킵. 로컬 파일 없음 | 없음 | Google Sheets API(`targets` 탭 조회) |
| `pnpm history:record --item --type --channel --status [--outlet <방 id>] [...]` | `local` 모드면 스킵. 로컬 파일 없음 | 로컬 파일 없음 | Google Sheets API(`history` 탭 upsert — 행의 식별자는 `(itemId, type, outletId)`이고 `--outlet`을 생략하면 방 칸이 빈 예전 행과 맞춰집니다) |
| `pnpm impressions:record [--since <YYYY-MM-DD>]` | `local` 모드면 스킵. `history` 탭 전체(`history!A2:I`); `channel=x`이고 `postId` 있는 행의 트윗을 `GET /twitter/tweets`로 조회(`--since`면 `publishedAt` ≥ 커트오프만). `TWITTERAPI_IO_KEY`(env) | 각 행의 **H(impressions=viewCount)·I(impressionsAt)** 만 갱신 — A–G는 안 건드림 | twitterapi.io(트윗 조회), Google Sheets(history 갱신) |
| `pnpm metrics:record [--month <YYYY-MM>]` | `local` 모드면 스킵. `GSHEET_ID`(env) 워크북의 `'KOL list'` 탭(헤더 이름으로 매핑, `Social media`가 X인 행만); `REFERENCE_X_HANDLE`(env)의 공식 계정 + 각 X KOL을 `GET /twitter/user/info`(followers) + advanced_search(그 달 글)로 조회. `TWITTERAPI_IO_KEY`(env). 기본 대상은 이번 달 | 같은 워크북의 `x-performance` 탭(없으면 생성)에 `(account, month)`별 행 upsert — followers/posts/views/engagement **raw 숫자만**. **사람 탭(로스터·계약·월별)·비용 컬럼은 절대 안 건드림**; 파생 지표(Cost per Impression 등)는 시트 수식이 담당 | twitterapi.io(계정 조회), Google Sheets(`x-performance` 갱신) |
| `pnpm kol-telegram:record [--month <YYYY-MM>]` | `local` 모드면 스킵. `GSHEET_ID`(env) 워크북의 `'kol-map'` 탭(`active`인 행만 — kolId·tgHandle·sheetLabel·pricePerPost·active); 각 활성 채널의 공개 프리뷰 페이지 `https://t.me/s/<handle>`를 `--month` 구간에 걸릴 때까지 페이지네이션(공식 API 아님, 별도 키 불필요); 매칭 후보로 `output/formatted/renderings.json`(`status: "approved"`이고 채널이 `telegram`인 행만, `FormattingStore.loadAll()` 경유). 기본 대상은 이번 달 | 같은 워크북의 `kol-telegram-posts` 탭(없으면 생성)에 `deliverableLink`(텔레그램 permalink) 키로 upsert — 신규 행은 전체 컬럼을 채움. 기존 행은 `views`/`engagements`/`reactionsDetail`/`fetchedAt` 4개를 갱신하고(단 `confirmed: "reject"` 행은 아예 손대지 않으므로 **그 행의 측정값도 함께 멈춤**), `itemId`/`matchScore`/`topic`/`pricePerPost`는 **그 칸이 아직 빈 경우에만** 채움(한 번 채워지면 다음 실행이 덮어쓰지 않음 — 이 블랭크 전용 규칙 덕분에 승인된 문구가 없어 빈 채로 만들어진 7월 행도, 문구가 생긴 뒤 같은 달을 다시 돌리면 소급 채워질 수 있음. 단 지난 달 재실행은 페이지 상한에 걸려 그 달에 닿지 못할 수 있으니 요약의 `channel(s) truncated`를 확인); **갱신 시 실제로 값이 달라진 칸만 씀** — 측정값만 바뀐 보통의 경우 `E:G`와 `L`만 쓰므로 `pricePerPost`(K)와 `confirmed`(M)는 기계가 쓰는 범위에 들어가지 않고, 바뀐 칸이 없으면 아무것도 쓰지 않음; `confirmed`와 이미 채워진 `topic`은 절대 안 덮어씀; `confirmed: "reject"` 행은 다시 제안하지 않음. 신규 행은 한 번의 append 호출로 모아서 씀(행마다 한 번씩 쓰면 Sheets의 분당 60회 쓰기 한도를 넘김). **`kol-map`/`KOL list`/계약 리스트/월별(`Jul.`/`Aug.`/`Sep.`) 탭은 전혀 쓰지 않음**(그중 `kol-map`만 읽기 전용으로 읽음); `confirmed`는 사람이 채우는 유일한 컬럼이고, 확정된 행을 월별 탭으로 옮기는 것도 사람의 몫 | Google Sheets API(`kol-map` 조회, `kol-telegram-posts` 갱신). 텔레그램 쪽은 공개 웹페이지 요청뿐이라 봇 토큰이나 별도 API 키가 필요 없음 |
| `pnpm sheet:init` | `local` 모드면 스킵. 로컬 파일 없음 | 로컬 파일 없음 — 생성된 스프레드시트 id를 콘솔에 출력 | Google Sheets API(스프레드시트 + `targets`/`history` 탭 생성) |
| `pnpm doctor [--live]` | 모든 env 설정 로더; `translation/glossary.json`, `translation/style-guide.md`, `translation/locale.json`, `conversion/x.md`의 존재 여부(4개 파일만 확인) | 없음 | `--live`일 때만: Google OAuth tokeninfo, Google Drive/Sheets 파일 메타데이터 조회, Lark 인증 + 채팅 목록 조회 |
| `pnpm status` | `output/x/items.json`, `output/lark/items.json`, `output/translations/translations.json`, `output/variants/variants.json`, `output/formatted/renderings.json`, `output/publish/state.json` | 없음 | 없음 |
| `pnpm archive` | `output/translations/worksheets/`, `output/variants/worksheets/`, `output/formatted/worksheets/`의 `.md` 목록 | 대상 파일들을 `output/archive/<YYYY-MM-DD>/`로 이동 | 없음 |
| `pnpm clean [--older-than <days>] [--yes]` | `output/archive/`의 날짜 폴더 목록; 좌초된 쓰기 잔해 탐지를 위해 `output/` 전체(`output/archive/` 내부는 제외)를 재귀 탐색 | 기본은 드라이런(삭제 대상만 출력). `--yes`일 때: 30일(기본값) 초과 경과한 `output/archive/<YYYY-MM-DD>/` 폴더 + `output/archive/`를 제외한 `output/` 안 어디에 있든 `*.tmp-<pid>-<ms>-<uuid>`(중단된 원자적 쓰기의 임시 파일) **또는 `*.lock`(예전 파일 잠금이 남긴 잔해 — 지금은 아무 코드도 만들지 않음)** 파일을 삭제 — 단 **마지막 수정이 31초보다 오래된 것만**(`*.tmp-…`·`*.lock` 동일 기준 — 살아 있는 발송이 쓰고 있는 파일일 수 있으므로 §5). **발송이나 `pnpm serve`가 도는 중에는 실행하지 마세요** | 없음 |
| `pnpm serve` | 대시보드 API를 통해 `output/translations/translations.json`, `output/variants/variants.json`, `output/formatted/renderings.json`, `output/publish/state.json`; `GET /api/renderings/:itemId/:type/:channel/emissions`는 저장된 canonical 텍스트를 요청 시점에 그 채널의 목적지(destination)별 텍스트로 변환해 돌려줍니다(파일로 저장되지 않고 그때그때 계산됨). **2차 검수(발송판) — `GET /api/items/:id/board`** 는 위 `renderings.json`에 더해 `output/formatted/overrides.json`(방별 override)과 `output/publish/deliveries.json`(없으면 예전 `channels.json`을 읽기 전용으로 이관 — `send:channels`와 동일한 이관 규칙)을 합쳐 카드·방 목록을 계산합니다 | 저장/승인/포맷 저장/게시 API 호출 시 위와 동일한 파일들; `local` 모드에서 게시하면 `output/publish/local/{review,approved}/*.md`도 포함(§2 참고). **발송판의 방별 API**: `PUT /api/outlets/:itemId/:type/:outletId`(글 저장 시 `overrides.json`에 그 방의 override를 쓰고, `승인`/`되돌리기`는 그 행을 갱신·삭제); `POST .../send`(자동 방 발송 — `output/publish/deliveries.json`에 `sent` 행을 씀, `pnpm send:channels`와 같은 원장); `POST .../mark`(수동 방 전달 체크/해제 — 같은 원장에 `delivered` 행); `POST /api/items/:id/convert-prepare`(체크한 유형의 워크시트 + `output/variants/pending.json` — `pnpm convert:prepare`와 동일); `POST /api/items/:id/format`(그 카드의 `output/formatted/renderings.json`을 그 자리에서 다시 씀 — 지금 저장된 문구와 승인 상태를 덮어씀, `✎따로` override는 건드리지 않음) | 게시 API 호출 시 모드에 따라 Google Drive API, Lark Drive API(`cloud`), 또는 없음(`local`); 발송판에서 자동 방에 `발송`을 누르면 CLI의 `pnpm send:channels`와 같은 Telegram Bot API / Typefully API 호출이 브라우저 조작만으로 즉시 일어남 |
| `pnpm google:auth` | `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`/`GOOGLE_OAUTH_SCOPE`(env) | 로컬 파일 없음 — refresh token을 콘솔에 출력 | Google OAuth 2.0(로컬 루프백 서버로 인가 코드 교환) |

`output/formatted/renderings.json`의 본문은 목적지(destination)별 철자가 아니라 **canonical
텍스트**입니다 — 어휘는 볼드 `**텍스트**`, 링크 `[텍스트](URL)`, 빈 줄 하나(문단 구분), 빈 줄 두
개(트윗 경계, x 채널 전용)가 전부입니다. 파이프라인이 오래전부터 트윗 스레드 구분에 써 온 `---`
한 줄짜리 구분선(`XContentSource`의 `THREAD_TWEET_SEPARATOR`)도 같은 트윗 경계로 인식됩니다
(`toCanonical`). x가 아닌 채널에서는 트윗 경계가 문단 구분으로 접힙니다
(`flattenPostBoundaries`). 실제 목적지별 철자는 저장 시점이 아니라 읽는 시점에
`src/domain/formatting/emitters/`가 canonical 텍스트로부터 만들어 냅니다 — 채널과 목적지의 대응은
[`capabilities.md`](capabilities.md) §3을 참고하세요.

과거에 있던 `--x-bold unicode` 옵션(유니코드 볼드 문자로 치환)은 제거되었습니다 — 스크린리더가 그
문자를 통째로 건너뛰고, X 검색이 매칭하지 못하며, 글자당 가중치도 2로 두 배가 되기 때문입니다.
이제 `--x-bold unicode`나 `--x-bold=unicode`를 넘기면 같은 이유를 담은 에러로 즉시 실패합니다
(`src/cli/format.ts`).

### `pnpm collect`의 두 수집 모드

X 수집은 `pnpm collect` 하나가 단일 창구입니다. (다만 twitterapi를 호출하는 명령이 collect뿐인
것은 아닙니다 — `pnpm reconcile`은 삭제 감지를 위해, `pnpm impressions:record`는 조회수 수집을
위해 각각 트윗을 재조회합니다. "수집"만 collect가 담당합니다.)

`collect`은 명령도 코드 경로도 하나이며, **플래그 유무라는 분기 하나**로 두 모드로 갈립니다.

| 모드 | 트리거 | `items.json` | `runs.json` | `state.json`(워터마크) |
|---|---|---|---|---|
| **증분** | 플래그 없음 | upsert | append | **전진(갱신)** |
| **ad-hoc** | `--since` 또는 `--limit` | upsert | append | **안 건드림** |

즉 `items`(병합)와 `runs`(커버리지 레코드)는 **매 실행 항상** 쓰이고, `state`(워터마크)만 모드에
따라 갈립니다. `--since`/`--limit`를 주면 워터마크를 갱신하지 않으므로(ad-hoc), 정기 자동화의
증분 흐름을 오염시키지 않고 임시 수집을 돌릴 수 있습니다. 기본값(플래그 없음)은 이전과 100%
동일하게 동작합니다.

#### 자동화 전략: 슬라이딩 윈도우 vs 워터마크

수집의 커버리지 메커니즘은 둘 중 하나입니다 — 어느 쪽을 실제로 써야 하는지는 "자동화가
뭐냐"에 따라 갈립니다.

- **워터마크 증분** (정기 스케줄러가 쓰는 방식) — 플래그 없는 `pnpm collect`. 실제 자동화는
  `pnpm watch`와 그 systemd 타이머([`team-runbook.md`](team-runbook.md) §6)이며, 이 스케줄러는
  `collect`를 아무 인자 없이 실행하도록 되어 있습니다 — 의도된 설계입니다.

  이득은 재수집이 최소라는 것입니다. 대가는 두 가지입니다: 워터마크가 최신으로 전진한 뒤에
  늦게 인덱싱된 트윗은 영구히 건너뛸 수 있고, 실행이 하나 밀렸을 때 메워 줄 오버랩 안전망이
  없습니다.

  그래도 정기 스케줄러가 이 방식을 필요로 하는 진짜 이유는 재수집량이 아니라 워터마크
  자체입니다: 신규 스레드 0건이면 그 tick이 에이전트를 아예 부르지 않고 끝나는 게이트가
  워터마크 전진에 의존합니다.
- **슬라이딩 윈도우** — 예: 매시간 `pnpm collect <target> --since 2h`. 2시간 창 + 1시간 주기 =
  1시간 겹침이라 실행 하나가 늦거나 실패해도 빈틈이 없고, API 인덱싱 지연(생성시각보다 늦게 검색에
  노출)도 오버랩이 흡수합니다. 겹치는 구간은 upsert가 중복 제거합니다. `--since`가 있으므로
  항상 ad-hoc이라 `state.json`을 쓰지 않습니다 — 워터마크는 놀게 됩니다(정상 동작이지만, 그래서
  **정기 스케줄러 자리에는 쓰면 안 됩니다**: 워터마크가 멈추면 위의 신규 스레드 0건 게이트가
  다시는 발동하지 않고, 매 tick이 같은 창을 반복 수집하게 됩니다). `--since`/`--limit`은
  정확히 워터마크를 갱신하지 않기 때문에, 정기 자동화가 아니라 **손으로 돌리는 백필**에 씁니다.

두 방식 모두 `runs.json`에 커버리지를 남깁니다. 요청한 floor까지 못 내려간 실행은
`truncated: true`와 `gap`으로 표시됩니다 — `--limit`로 잘렸거나 `DEFAULT_MAX_PAGES`(50페이지)
상한을 소진한 경우입니다. 워터마크 증분 모드에서 `DEFAULT_MAX_PAGES` 상한에 걸리면 워터마크가 이미 그 실행이
가져온 최신 트윗까지 전진해 있어 영구적인 유실이 됩니다 — 증상/원인/조치는
[`team-runbook.md`](team-runbook.md) §4 "수집에 구멍이 생겼을 때 (GAP 알림)"을 참고하세요.

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

`stale`로 판정된 행은 대상에 따라 다른 방식으로, 그러나 모두 중복 없이 재게시됩니다. Google은
파일 id·공유 링크를 유지한 채 PATCH하고, `local`(`LocalFileUploader.update`)은 새 내용을 다시 쓴
뒤 파일명이 바뀌었으면(예: 재승인으로 `approvedAt` 날짜가 바뀐 경우) 이전 파일을 지워 하나만
남깁니다. Lark(`LarkDriveUploader.update`)는 `drive/v1`에 콘텐츠 교체 API가 없어 **새 파일을 올린
뒤 예전 파일을 삭제**하므로, 폴더에는 하나만 남지만 **`file_token`과 링크는 매번 바뀝니다**. 예전
파일 삭제가 실패하면 게시는 성공으로 처리하고 고아 토큰을 경고로 남깁니다(원장은 새 파일을 가리키
므로 재업로드가 반복되지는 않습니다).

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
전용, 대상 세 가지 모두)를 서로 다른 상황에만 써야 하며, 두 절차를 구분해 정리한 문서는
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
- 만료된 `output/archive/<YYYY-MM-DD>/` 폴더와, 좌초된 쓰기 잔해 두 종류를 삭제 대상으로 삼습니다
  (`output/archive/` 내부를 제외한 `output/` 전체를 재귀 탐색해 탐지 — `output/archive/`는 위 항목에서
  폴더 단위로 이미 다뤄지므로 내부까지 다시 훑지 않습니다):
  - `*.tmp-<pid>-<ms>-<uuid>` — 중단된 원자적 쓰기가 남긴 임시 파일.
  - `*.lock` — 원장 쓰기를 프로세스 사이에서 직렬화하던 옛 파일 잠금이 남긴 파일. 이 잠금 자체가
    폐지되어 이제는 아무 코드도 `.lock` 파일을 만들지 않으므로, 남아 있다면 전부 이 버전 이전에
    쓰던 설치본의 잔해입니다.
- **두 종류 모두 같은 하나의 기준으로 판정합니다 — 마지막 수정이 31초보다 오래됐는가.** 예전에는
  둘을 서로 다르게 판정했습니다: `.lock`은 잠금 모듈 자신의 회수 규칙(나이 30초 + 확인 구간 1초,
  그 사이 수정 시각이 움직이면 살아 있는 프로세스로 보고 건너뜀)을 그대로 따랐고, `.tmp-…`는 자기
  시각이 아니라 그 파일이 올라갈 원장의 잠금으로 판정했습니다(한 번의 쓰기가 만든 짝인데 갱신되는
  것은 잠금뿐이었기 때문). 잠금 자체가 없어진 지금은 그 잠금 모듈도, "살아 있는 프로세스가 쥔 것인지"
  물을 대상도 없습니다 — `.lock`이 하나라도 남아 있다면 그것은 이미 버려진 파일이므로, 두 패턴 모두
  하나의 단순한 나이 기준으로 판정합니다.
  - `writeJsonFileAtomic`의 `writeFile` 다음 `rename`은 이 도구가 도는 어떤 디스크에서도 한 자릿수
    밀리초 안에 끝나므로, 31초는 "쓰기가 오래 걸릴 수 있다"는 가정이 아니라 여유 폭입니다. 다만 그
    여유가 실제로 지키는 대상은 **느린 디스크가 아니라 튀는 시계**입니다: `mtime`은 벽시계 시간이고,
    이 프로젝트가 개발된 환경(WSL2)의 `CLOCK_REALTIME`은 실측상 ±22.7초까지 앞뒤로 튀므로(Hyper-V
    호스트 시간 동기화와 `systemd-timesyncd`가 동시에 시계를 건드림), 방금 쓴 파일도 한순간 그만큼
    오래돼 보일 수 있습니다. 31초는 이 튐에 견주면 한 자릿수 초의 여유만 남습니다.
  - 예전 잠금 모듈은 살아 있는 프로세스가 자기 잠금의 수정 시각을 주기적으로 다시 찍어(heartbeat)
    이 튐을 버텼고, "수정 시각이 실제로 움직였는가"라는 시계에 기대지 않는 두 번째 신호로 오탐을
    걸러냈습니다. 지금은 그 heartbeat도, 그것이 갱신할 살아 있는 소유자도 없습니다 — 여기 남는
    잔해는 애초에 진행 중인 쓰기가 아니라 버려진 파일이기 때문입니다 — 그래서 이 보강책은 되살릴
    여지가 없고, 남은 것은 단순한 1회성 나이 검사뿐입니다. 이 값을 다시 조정할 사람은 이것이
    디스크 속도가 아니라 시계 튐의 크기에 맞선 것이며, 오늘 이 기기가 실측한 최대 튐 대비 여유가
    한 자릿수 초뿐이라는 점을 알아야 합니다.
- 살아 있는 잠금을 지우면 두 프로세스가 같은 원장을 동시에 고쳐 써 행이 유실되고, 원자적 쓰기의
  임시 파일을 `writeFile`과 `rename` 사이에서 지우면 **발송은 나갔는데 원장에는 남지 않습니다**.
  앞의 위험은 `.lock`이 애초에 만들어지지 않는 지금은 일어나지 않지만, 뒤의 위험은 여전히 실제
  위험입니다 — 이 판정은 안전망이지 허가가 아니므로, **발송이나 `pnpm serve`가 도는 중에는
  `--yes`로 실행하지 마세요.**
- 기본은 **드라이런**입니다 — 무엇을 지울지 목록만 출력합니다. 실제 삭제는 `--yes`를 붙여야
  일어납니다.
- 살아 있는 저장소(store) 파일은 절대 건드리지 않습니다. 대상은 만료된 아카이브 폴더와 임시 파일
  패턴에 정확히 일치하는 파일뿐입니다.

## 6. 잃으면 안 되는 것 vs 지워도 되는 것

**잃으면 안 되는 것 (사람의 노동이 담긴 산출물 · 재생성 불가):**

- `output/translations/translations.json` — 사람이 손으로 번역한 한글 원문
- `output/variants/variants.json` — 채널별 변환 결과
- `output/formatted/renderings.json` — 채널별 최종 포맷 렌더링
- `output/formatted/overrides.json` — 방별로 따로 검수·승인한 글(override). 그룹 렌더링과는 별개로
  사람이 그 방만을 위해 고친 텍스트라, 잃으면 그 방은 그룹 글로 조용히 되돌아가고 고친 내용
  자체는 재생성할 수 없습니다.
- 실제 스티어링 파일: `translation/glossary.json`, `translation/style-guide.md`,
  `translation/locale.json`, `translation/few-shot.json`, `conversion/{x,announcement,kol,pr}.md`,
  `conversion/few-shot.{x,announcement,kol,pr}.json`
- `output/x/state.json`, `output/lark/state.json` — 수집 워터마크. 잃으면 에러 없이 조용히 재수집
  구간이 비게 됩니다.

> **`pnpm state:push`가 데이터베이스에서 읽어 Drive 스냅샷으로 묶어 주는 것**(손으로 챙기지 않아도
> 되는 것) — 파이프라인 순서대로 일곱 개입니다:
> - **사람이 검수한 글** — `output/translations/translations.json`(1차 번역문과 승인 상태),
>   `output/variants/variants.json`(타입별 변환본). 파이프라인을 다시 돌리면 *어떤* 번역·변환본은
>   나오지만 **그 번역·변환본은 아닙니다** — 에이전트가 다시 쓰고 1차·2차 검수를 다시 해야 합니다.
> - `output/formatted/renderings.json` — 채널별 최종 포맷 렌더링과 그 **2차 검수 승인 상태**
>   (`status`/`approvedAt`/`refined`). `format`이 렌더링 *텍스트* 자체는 변환본에서 그대로 다시
>   만들어내는 순수 코드이지만, 사람이 그 렌더링을 승인했다는 사실이나 손으로 고친 내용
>   (`refined: true`)까지 재생성하지는 못하므로 함께 챙깁니다.
> - `output/formatted/overrides.json` — 방별 포크(위 목록에 있음).
> - 잃으면 **이미 보낸 글을 다시 보내게 되는** 원장 셋 — `output/publish/deliveries.json`,
>   `output/publish/x-article.json`, `output/publish/state.json`.
>
> 복구는 `pnpm state:pull` (`--yes` 없이는 미리보기, 파일마다 현재 행 수와 스냅샷 행 수를 나란히
> 보여줍니다). 복구는 **가져오기**입니다 — 기존 파일을 덮어쓰던 예전 방식과 달리, 스냅샷의 각
> 행을 데이터베이스에 upsert할 뿐 스냅샷에 없는 기존 행을 지우지는 않습니다. 갓 만든 빈
> 데이터베이스로 복구할 때는 결과가 같지만, 이미 다른 기록이 있는 데이터베이스에 복구할 때는
> 차이가 납니다.
>
> **스냅샷에 안 들어가는 것은 여전히 직접 챙기세요**: 스티어링 파일은
> `pnpm config:push`/`config:pull` 쪽이고, 수집 워터마크(`output/x/state.json`,
> `output/lark/state.json`)는 어느 명령도 백업하지 않습니다.
> 예전 `output/publish/channels.json`(`deliveries.json`이 없을 때만 읽히던, 방(outlet) 축이
> 생기기 전의 발송 원장)은 더 이상 스냅샷에 들어가지 않습니다 — `pnpm db:import`가 그 안의 행을
> 이미 `deliveries.json` 쪽으로 옮겨 놓은 뒤이므로, 데이터베이스에는 따로 스냅샷할 예전 형식이
> 남아 있지 않습니다.

**지워도 되는 것 (재생성 가능하거나 이미 다른 곳에 보존됨):**

- 이미 `pnpm archive`로 옮긴 뒤의 워크시트 원본(`output/{translations,variants,formatted}/worksheets/*.md`) — `prepare`를 다시 실행하면 재생성됩니다
- `output/publish/local/{review,approved}/*.md` — `translations.json`에서 파생된 발행본이라 원리상 재생성 가능하지만, 동기화 원장(`output/publish/state.json`)에 기록이 남아 있으면 `drive:publish`가 스킵하므로 **다시 만들려면 해당 원장 행을 지우고 재발행**해야 합니다. `local` 모드에선 이게 공유용 최종본(§1의 기록의 원본)이므로 백업을 권장합니다
- 보존 기간이 지난 `output/archive/<YYYY-MM-DD>/` 폴더
- `*.tmp-*` 임시 파일 — 중단된 원자적 쓰기의 잔재
- `output/x/items.json`, `output/lark/items.json` — twitterapi.io / Lark에서 다시 수집할 수
  있습니다 (단, 재수집은 워터마크 이후 구간만 가져오므로 워터마크가 함께 없을 때만 완전한
  재수집이 됩니다)
- `output/x/runs.json` — 매 `pnpm collect` 실행마다 커버리지 레코드를 append하는 로그입니다.
  잃어도 파이프라인 동작에는 영향이 없고, 과거 커버리지 이력(언제 어느 구간을 수집했는지)만
  사라집니다

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

반면 루트 `conversion/`과 `output/variants/`처럼 **디렉터리끼리** 이름이 달라 보이는 것은 마찰이
아니라 §1의 이름 규칙(루트는 프로세스, `output/`은 산출물)이 의도대로 적용된 결과입니다.
