# 팀 운영 매뉴얼 (team-runbook.md)

Mantle KR 팀이 `mantle-kr-herald`를 실제로 운영할 때 보는 문서입니다. 프로젝트가 무엇을
하는지는 [`capabilities.md`](capabilities.md)를, 명령이 정확히 무엇을 읽고 쓰는지는
[`artifacts.md`](artifacts.md)를 참고하세요. 처음 받아서 로컬로만 써 보는 절차는
[`quickstart.md`](quickstart.md)를 보세요 — 이 문서는 그 이후, 우리 팀 자격 증명으로 클라우드
모드(`cloud`)를 운영하는 단계를 다룹니다.

## 1. 준비물

우리 팀의 구체적인 자산입니다. **값은 절대 이 문서에 적지 않습니다** — 전부 `.env`(git에
커밋되지 않음)에 있고, 여기서는 변수 이름만 참조합니다.

- Lark 앱과 운영 그룹 채팅 — 셋업은 [`lark-setup-guide.md`](../guides/lark-setup-guide.md).
  수집 대상 채팅방 id는 `LARK_CHAT_IDS`.
- Google Drive의 review/approved 폴더 — 셋업은
  [`google-drive-setup-guide.md`](../guides/google-drive-setup-guide.md)와
  [`drive-setup-guide.md`](../guides/drive-setup-guide.md). 폴더 id는
  `GDRIVE_REVIEW_FOLDER_ID`/`GDRIVE_APPROVED_FOLDER_ID`.
- Google Sheet 데이터 허브(수신처 `targets` 탭, 게시 이력 `history` 탭) — 스프레드시트 id는
  `GSHEET_ID`.
- `.env`의 `HERALD_STORAGE_MODE=cloud` — 팀 운영에서는 항상 `cloud`입니다. Drive/Sheet가
  기록의 원본(record of truth)이 되어야 하므로, 로컬에만 쌓아 두는 `local` 모드는 개인 실습용
  입니다([`artifacts.md`](artifacts.md) §2).

값이 맞게 설정됐는지는 명령을 실행하기 전에 항상 `pnpm doctor`(오프라인) 또는
`pnpm doctor --live`(실제 토큰 발급까지)로 확인하세요.

## 2. 주간 루틴

일반적인 한 주의 명령 순서와 각 검수 단계에서 누가 무엇을 하는지입니다.

1. **수집** — 운영자가 `pnpm collect`(X)와 `pnpm collect-lark`(Lark 그룹 채팅)를 실행합니다.
2. **번역 준비** — 운영자가 `pnpm translate:prepare`로 워크시트를 만듭니다.
3. **번역** — Claude Code 에이전트가 워크시트의 번역 섹션을 채웁니다.
4. **번역 저장** — 운영자가 `pnpm translate:save --id <id> --file <ko.txt>`로 저장합니다
   (아직 승인은 아님).
5. **1차 검수** — 검수자가 `pnpm serve`를 띄우고 대시보드의 번역 검수 모드에서 각 항목을
   읽고, 필요하면 고쳐서 승인(approve)합니다. 승인해도 업로드는 일어나지 않습니다 — approve는
   상태만 바꿀 뿐입니다([`capabilities.md`](capabilities.md) §4).
6. **변환 준비 → 변환 → 저장** — 운영자가 `pnpm convert:prepare`로 워크시트를 만들고,
   에이전트가 X/KOL/PR 타입별로 채우고, `pnpm convert:save --id <id> --type <t> --file <f>`로
   저장합니다.
7. **채널 포맷** — 운영자가 `pnpm format`(결정적 포맷터, 즉시 저장)이나
   `pnpm format --refine`(에이전트 다듬기 필요 시) + `pnpm format:save`를 실행합니다.
8. **2차 검수** — 검수자가 대시보드의 채널 검수 모드에서 채널별 렌더링을 검수·승인합니다.
9. **발행** — 운영자가 `pnpm drive:publish`를 실행하거나(또는 대시보드의 발행 버튼) —
   `cloud` 모드에서만 동작하며, 이 순간에만 실제로 Drive/Lark Drive에 업로드됩니다.
10. **기록** — 운영자가 필요 시 `pnpm history:record`로 Google Sheet `history` 탭에 게시
    이력을 남깁니다. 배포 대상 목록은 `pnpm targets:list`로 확인합니다.
11. **정리** — 배치가 끝나면 `pnpm archive`를 실행합니다(§5).

한 주가 끝나기 전에 `pnpm status`로 어디까지 진행됐는지 항상 확인할 수 있습니다.

## 3. 검수 기준

번역 톤·용어 규칙은 `translation/style-guide.md`와 `translation/glossary.json`을, 채널별
(X/KOL/PR) 변환 규칙은 `conversion/x.md`, `conversion/kol.md`, `conversion/pr.md`를 따릅니다
— 규칙 자체는 이 문서에 옮겨 적지 않습니다. 이 파일들은 `pnpm config:init`이 만들어 주는 팀
자산이고([`quickstart.md`](quickstart.md) §4), git에 추적되지 않는 로컬 파일이라 저장소를
새로 받은 직후에는 존재하지 않습니다 — 팀이 검수하면서 직접 다듬어 나가는 살아있는 문서입니다.

## 4. 사고 대응

세 가지 확인된 장애 상황과 대응입니다.

### 미동기화가 밀렸을 때

**증상** — `pnpm status`의 `sync:` 줄에 `⚠`와 함께 `N unsynced`(또는 `stale`)가 표시됩니다.
예: `⚠ sync: 12 published · 5 unsynced`.

**원인** — 번역이 승인됐지만 아직 `pnpm drive:publish`로 업로드되지 않았거나(`unsynced`),
업로드는 됐지만 승인 이후에 내용이 수정돼 Drive에 남은 버전이 옛 버전인 경우(`stale`)입니다.
이 구분은 동기화 원장(`output/publish/state.json`)의 `contentHash`가 만듭니다 — 업로드 시점의
바이트 해시와 현재 내용을 같은 방식으로 다시 해시한 값을 비교해서, 값이 다르면 `stale`로
표시합니다([`artifacts.md`](artifacts.md) §4).

**조치** — `pnpm drive:publish`를 실행하면 `unsynced`와 `stale` 둘 다 해소됩니다. `unsynced`
항목(원장에 아직 행이 없는 항목)은 새로 업로드되고, `stale` 항목(원장에 행은 있지만
`contentHash`가 현재 내용과 다른 항목)은 기존 Drive 파일을 **그 자리에서 갱신**합니다 — 파일
id와 공유 링크가 그대로 유지되고, 중복 파일이 생기지 않습니다. CLI는 두 종류를 구분해
`published N new + M updated across ...` 형태로 보고합니다(`src/cli/publish.ts`).

**Google Drive에서만 동작합니다.** Lark Drive `drive/v1`에는 내용을 그 자리에서 바꾸는
엔드포인트가 없으므로, Lark 대상의 `stale` 항목은 자동 갱신되지 않고 해당 항목을 지목하는
실패로 보고됩니다(`✗ <itemId>:<status>:lark: ... cannot update ...`). CLI 메시지가 그대로
안내하는 두 가지 중 하나로 처리하세요 — ① Drive에서 해당 파일을 직접 찾아 손으로 내용을
고치거나, ② 동기화 원장(`output/publish/state.json`)에서 그 행을 지우고 `pnpm drive:publish`를
다시 실행해 새 파일로 재게시합니다. ②를 택하면 Drive에는 예전 파일이 그대로 남으므로 **직접
찾아 지워야** 중복이 생기지 않습니다.

**동기화 원장이 생기기 전에 게시된 항목은 `contentHash`가 없습니다.** `migrateLegacyKeys`로
변환된 이런 행은 값을 몰라서 비어 있는 것이지 최신이라서가 아니므로, "모름"을 "변경 없음"으로
취급해 `stale`로도 보고되지 않고 재업로드되지도 않습니다. **이 상태는 영구적입니다.**
`src/app/PublishTranslations.ts`는 원장에 행이 있고 `contentHash`가 없으면(`isStale`이 `false`를
반환) 비교조차 하지 않고 그 자리에서 건너뛰므로 `record()`가 다시 호출될 일이 없습니다 — 따라서
이런 행은 **그 항목이 나중에 다시 게시되어도 `contentHash`를 얻지 못합니다.** 즉 이런 항목의
번역을 고쳐도 Drive에는 옛 한국어 텍스트가 그대로 남고, `pnpm status`는 `stale`을 `0`으로
보고하며, `pnpm drive:publish`는 조용히 아무 일도 하지 않습니다 — 아래 절차로 원장 행을 직접
정리하기 전까지는 그 항목의 수정 여부가 전혀 감지되지 않습니다.

**빠져나가는 방법은 하나뿐이고, `contentHash`가 아예 없는 레거시 행에만 씁니다.**
`output/publish/state.json`을 열어 해당 `(itemId, status, target)` 행을 지운 뒤
`pnpm drive:publish`를 다시 실행하세요 — 원장에 행이 없으니 새 파일로 업로드되고, 이번에는
`contentHash`가 함께 기록되어 이후부터는 정상적으로 `stale` 판정을 받습니다. 다만 Drive에는
예전 파일이 그대로 남으므로 **직접 찾아 지워야** 중복이 생기지 않습니다.

**이 수동 절차는 `contentHash`가 아예 없는 행에 씁니다 — `contentHash`가 있는데 값만 달라진
`stale` 행이라면, 대상이 Google인 경우에 한해 절대 쓰지 마세요.** Google `stale` 행은 위에서
설명한 자동 경로가 이미 처리해 파일 id와 공유 링크를 그대로 유지하는데, 원장 행을 지우고
재게시하면 새 파일 id가 발급되어 그 보장이 깨지고 불필요한 중복까지 생깁니다. (Lark `stale`
행은 자동 경로 자체가 없으므로 위 ②번이 정당한 선택지입니다 — 그래서 이 금지는 Google에만
적용됩니다.) 정리하면 판단 기준은 두 가지입니다: **`contentHash`가 있는가**, 그리고 **대상이
Google인가.** 둘 다 예일 때만 손대지 말고 자동 경로에 맡기세요.

### `pending.json`을 날렸을 때

**증상** — 저장하지 않은 워크시트 배치가 사라진 것처럼 보입니다(예:
`output/translations/pending.json`이 예상과 다른 배치를 가리킴).

**원인** — `translate:prepare`, `convert:prepare`, `format --refine`은 실행할 때마다
`pending.json`을 새 배치로 덮어씁니다. 저장하지 않은 채로 같은 `prepare`를 두 번째로 돌리면
이전 배치가 통째로 대체됩니다.

**조치** — 걱정할 필요는 없습니다. 덮어쓰기 직전에 이전 `pending.json`이 자동으로
`output/archive/<날짜>/pending-*.json`으로 이동해 있습니다([`artifacts.md`](artifacts.md)
§5). 그 파일을 원래 위치로 복사해 되돌리거나, 같은 항목 id로 `prepare`를 다시 실행하면
됩니다. `translate:save` / `convert:save` / `format:save`는 `pending.json`에 항목이 없으면
이미 저장된 값으로 자동 폴백하므로, 재저장·재승인도 그대로 됩니다.

### 워터마크가 꼬였을 때

**증상** — `pnpm collect` 또는 `pnpm collect-lark`가 예상과 다른 범위를 수집합니다(전부
다시 수집하거나, 최근 항목을 놓침).

**원인** — `output/x/state.json`, `output/lark/state.json`이 각각 X/Lark 수집의 워터마크를
담고 있습니다([`artifacts.md`](artifacts.md) §6). 이 파일이 없어지면 다음 수집은 전체
재수집이 됩니다(에러 없이 조용히). 타임스탬프를 과거로 고치면 그 시점 이후로 재수집됩니다.

**조치** — 의도적인 전체 재수집이 필요하면 해당 `state.json`을 지우고 다시 수집하세요. 특정
시점 이후로만 다시 가져오고 싶으면 워터마크 타임스탬프를 그 시점으로 직접 편집하세요. 둘 다
기존에 저장된 `items.json`을 지우지 않으므로 upsert로 안전하게 병합됩니다.

## 5. 정리 주기

- **배치마다** — `pnpm archive`로 완료된 워크시트(`output/{translations,variants,formatted}/worksheets/*.md`)를
  `output/archive/<날짜>/`로 옮깁니다. `prepare`를 다시 실행하면 재생성되는 산출물이라
  안전합니다.
- **월간** — `pnpm clean`으로 오래된 아카이브와 좌초된 임시 파일을 정리합니다. 기본은
  **드라이런**이라 지울 목록만 출력하고, 실제로 지우려면 `--yes`를 붙여야 합니다:
  ```bash
  pnpm clean               # 무엇이 지워질지 목록만 확인
  pnpm clean --yes         # 실제로 삭제
  ```
  보존 기간은 기본 30일이며 `--older-than <days>`로 바꿀 수 있습니다. 경계는 엄격히
  초과(strictly greater) 기준이라 정확히 30일 된 아카이브 폴더는 이번 실행에서는 지워지지
  않습니다([`artifacts.md`](artifacts.md) §5).

## 6. 다음으로

- 명령이 정확히 무엇을 읽고 쓰는지 궁금하면 → [`artifacts.md`](artifacts.md)
- 이 프로젝트가 무엇을 하고 무엇을 하지 않는지 궁금하면 → [`capabilities.md`](capabilities.md)
- 처음 로컬로 설치해서 감을 잡고 싶으면 → [`quickstart.md`](quickstart.md)
