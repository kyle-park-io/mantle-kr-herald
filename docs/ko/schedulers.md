# 스케줄러 한눈에 보기 (schedulers.md)

**이 문서는 목록입니다.** 이 저장소에는 systemd 사용자 타이머가 여섯 개 있고, 다섯 개는
[`team-runbook.md`](team-runbook.md) §6에, 나머지 하나(`herald-backup`, 파이프라인이 아니라
스티어링·프로덕션 상태 백업)는 [`setup/steering.md`](setup/steering.md) §6에 자세한 설명이
있습니다. 다만 `team-runbook.md`는 1,800줄이고 그 다섯 절이 수백 줄씩 떨어져 있어서,
**"지금 무엇이 자동으로 돌고 있나"** 하나만 알고 싶은 사람이 읽을 물건이 아니었습니다. 이 문서가 그
질문에만 답합니다.

**여기 적힌 사실의 출처는 산문이 아니라 `deploy/`의 유닛 파일 자체입니다.** 표의 유닛 이름과
`OnCalendar=` 값은 `tests/docs/schedulerOverview.test.ts`가 `deploy/*.timer`와 직접 대조하므로,
타이머를 하나 더 만들고 이 표를 고치지 않으면 CI가 막습니다. 반대로 **주기·설치 절차·사고 대응
같은 세부는 여기에 다시 쓰지 않고 링크만 겁니다** — 같은 설명을 두 벌로 두면 어긋나는 건 시간
문제이고, 이 저장소는 코드와 어긋난 문서 주장 일곱 개를 고치는 데 하루를 쓴 적이 있습니다.

## 여섯 개의 타이머

| 유닛 | 언제 (`OnCalendar=`) | 한 번 돌 때 무엇을 하나 | 자세히 |
| --- | --- | --- | --- |
| `herald-watch` | `*-*-* 0/2:17:00` | 두 시간마다. `pnpm watch` — `collect`(X만) → (새 글이 있을 때만) `translate:prepare` → 에이전트 → `translate:align` → (정렬할 선례가 있을 때만) 에이전트. `status: "translated"`에서 멈춥니다. | [§6 watch 스케줄러](team-runbook.md#6-watch-스케줄러-자동화) |
| `herald-convert` | `*-*-* *:07,37:00` | 30분마다, 하루 24시간. `pnpm convert:tick` — `convert:prepare` → (준비된 게 있을 때만) 에이전트가 워크시트를 채우고 변환마다 `convert:save` → 마지막에 `format --only-missing`. `status: "rendered"`에서 멈춥니다. | [변환 스케줄러](team-runbook.md#변환-스케줄러-herald-convert) |
| `herald-x-reconcile` | `*-*-* 0/6:41:00` | 여섯 시간마다. `pnpm x:reconcile --yes` — @0xMantleKR 타임라인을 읽어 우리 기록과 맞춥니다. X에는 아무것도 올리지 않지만, 딜리버리 원장·`history` 시트 탭·번역 상태에는 **씁니다**. | [X 발행 재확인](team-runbook.md#x-발행-재확인-herald-x-reconcile) |
| `herald-creds` | `*-*-* 06:23:00` | 하루 한 번, 업무 시작 전. `pnpm creds:check` — 배포본에 HTTP로 물어 크레덴셜이 아직 살아 있는지 확인합니다. | [크레덴셜 상시 점검](team-runbook.md#크레덴셜-상시-점검-herald-creds) |
| `herald-translate-check` | `Mon *-*-* 06:53:00` | **주 1회, 월요일.** 이 유닛만 `ExecStart=`가 두 줄입니다 — `pnpm translate:check --notify` 다음 `pnpm glossary:mine --notify`. | [용어집 주간 다이제스트](team-runbook.md#용어집-주간-다이제스트-herald-translate-check) |
| `herald-backup` | `*-*-* 05:47:00` | 하루 한 번, 업무 시작 전. `pnpm config:push`로 스티어링 설정을, 이어서 `pnpm state:push`로 프로덕션 운영 상태(few-shot 코퍼스 포함)를 Drive에 백업합니다. 파이프라인이 아니라 `herald-watch`·`herald-convert`와는 다른 결의 유닛입니다. | [자동 백업](setup/steering.md#6-백업) |

분 단위가 전부 다른 것(`:07/:37`, `:17`, `:41`, `:23`, `:47`, `:53`)은 우연이 아닙니다. 여섯
유닛이 같은 배포 체크아웃에서 같은 데이터베이스를 향해 `pnpm`을 돌리고 그중 둘은 `claude -p`까지
띄우므로, 분을 나눠 쓰면 잃을 게 없고 겹치면 잠든 Neon 컴퓨트 위에서 두 실행이 동시에 깨어납니다.
각 타이머 파일이 서로의 분을 피해 적혀 있고, `tests/deploy/credsTiming.test.ts`와
`tests/deploy/translateCheckTiming.test.ts`가 `deploy/`에서 그 분들을 다시 읽어 충돌을 막습니다.

## 여섯이 공유하는 구조

유닛 파일을 하나 열어 본 적이 있다면 나머지 다섯은 거의 같은 모양입니다.

- **`Type=oneshot`** — 명령이 끝나야 실행이 끝난 것으로 칩니다. `herald-translate-check`의
  `ExecStart=` 두 줄이 순서대로 도는 것도 이 값 덕분입니다.
- **`WorkingDirectory=%h/.herald/app`** — **배포 체크아웃**, 머지된 `main`만 있는 트리입니다.
  누가 편집하는 개발 체크아웃이 **아닙니다.** 2026-08-07에 유닛 하나가 개발 체크아웃을 가리키고
  있던 탓에 머지되지 않은 브랜치의 쿼리가 프로덕션에서 돌았고, 그 뒤로
  `tests/deploy/workingDirectory.test.ts`가 이 줄을 지킵니다.
- **`EnvironmentFile=%h/.herald/prod.env`** — `DATABASE_URL`과 `HERALD_DB_ENV=production` 두 줄뿐인
  파일입니다. 이게 있어야 스케줄러가 저장소 `.env`의 로컬 Docker가 아니라 **프로덕션 Neon**을
  향합니다. **`herald-creds`만 이 줄이 없습니다** — 데이터베이스를 열지 않고 배포본에 HTTP로 묻기만
  하므로, 걸어 두면 없는 의존성을 있는 것처럼 적는 셈입니다(`tests/deploy/credsTiming.test.ts`가
  그 부재를 못박아 둡니다).
- **`Environment=PATH=%h/.herald/bin:…`** — `node`·`pnpm`은 심볼릭 링크 디렉터리를 통해 잡습니다.
  nvm 버전 경로를 직접 적으면 노드를 올릴 때 그 디렉터리가 사라져 다음 발화가 203/EXEC로 죽습니다
  (2026-08-09에 실제로 겪었습니다). 노드를 올린 뒤에는 유닛이 아니라 **심링크를** 다시 겁니다.
- **`OnFailure=herald-notify-failure@%n.service`** — 어떤 이유로든 0이 아닌 종료(자기 자신의
  `TimeoutStartSec=` 포함)면 텔레그램 ops 방으로 알림이 갑니다. `%n`이라 알림이 **자기 유닛**의
  이름과 저널을 싣습니다.
- **`ExecStart=… deploy/herald-run-logged.sh %n …`** — 모든 명령이 래퍼를 거칩니다. 이 머신의
  journald는 시계가 뒤로 튈 때마다 로테이트해서 실제로 읽을 수 있는 창이 약 8분뿐이라, 실행 로그는
  `~/.herald/logs/<유닛 이름>/`에 따로 남습니다(유닛 디렉터리마다 최근 60개). 래퍼는 종료 코드를
  **그대로** 돌려주므로 위 실패 알림이 살아 있습니다.
- **타이머 쪽 `Persistent=true`** — 머신이 꺼져 있어(또는 WSL2의 단골 실패인 사용자 매니저 미기동)
  놓친 발화를 다음 부팅·로그인 때 한 번 돌립니다. 여러 번 밀렸어도 한 번으로 합쳐집니다.
- **`loginctl enable-linger`** — 유닛 파일이 아니라 **머신 설정**이고, 기본값이 꺼짐입니다. 꺼져
  있으면 사용자 유닛은 로그인해 있는 동안만 살아서, 마지막 셸을 닫는 순간 여섯 타이머가 같이
  사라집니다. "분명히 켰는데 `list-timers`가 비어 있다"는 대개 이것입니다
  ([§6 설치 7번](team-runbook.md#설치)).

설치 파일 목록(서비스·타이머 열두 개와 공용 실패 훅 하나)은 **여기에 옮겨 적지 않습니다.** 저장소에
완전한 목록은 하나뿐이어야 하고, 그건 runbook의 `cp` 블록입니다 — 한때 그 목록이 넷만 적고 있던
탓에 **타이머 없는 서비스**가 깔린 적이 있습니다. 설치할 때는 [§6의 그 블록](team-runbook.md#설치)을
통째로 쓰세요.

## 스케줄러가 **하지 않는** 것

무엇을 하는지만큼 중요한 목록입니다. 이 여섯 유닛이 사람 대신 결정하는 일은 없습니다.

- **아무것도 승인하지 않습니다.** 에이전트를 띄우는 건 `herald-watch`와 `herald-convert` 둘뿐이고,
  그 둘의 프롬프트(`src/adapters/agent/ClaudeCodeAgent.ts`에 문자열 상수로 들어 있습니다)가
  `--approve`를 어떤 경우에도 붙이지 말라고 명시합니다. 같은 금지가 `claude`에 넘기는
  `--disallowedTools` 인자에도 `Bash(*--approve*)`로 들어갑니다. **다만 실제로 짐을 지는 쪽은
  거부 목록이 아니라 허용 목록입니다** — 에이전트에게 열린 셸 명령은 종류당 딱 하나
  (`pnpm translate:save --id * --file *` 또는 `pnpm convert:save --id * --type * --file *`)이고,
  거부 규칙의 앞자리 와일드카드가 실제로 그렇게 매칭되는지는 코드 주석 자신이 "미확인"이라고
  적어 두었습니다.
- **공개 채널로 아무것도 내보내지 않습니다.** 실제로 밖으로 나가는 명령은 `pnpm send:channels`,
  `pnpm send:x-article`, `pnpm lark:send`, `pnpm drive:publish` 넷인데, `deploy/` 전체에서 이
  이름들은 **한 번도 나오지 않습니다.** 넷 다 에이전트 거부 목록에 이름이 올라 있고, 넷 다 위
  한 줄짜리 허용 목록 밖입니다. 발송은 승인된 렌더링만, 사람이 대시보드에서 누를 때 나갑니다.
- **X에는 아무것도 올리지 않습니다.** `x:reconcile`은 twitterapi.io를 **읽기만** 합니다.
- **단, "아무것도 쓰지 않는다"는 뜻은 아닙니다.** `herald-x-reconcile`의 `--yes`는 딜리버리 원장,
  팀 공용 시트의 `history` 탭, 번역 상태(`게시됨`)와 발행 원문에 **씁니다** — 다만 전부 *기록*이지
  발행이 아닙니다. `herald-translate-check`도 검토 파일 하나를 씁니다.
- **텔레그램 알림은 예외이고, 그건 발송이 아닙니다.** 여섯 유닛 전부 실패하면 ops 방으로 알림을
  보내고, `--notify`가 붙은 두 명령과 `x:reconcile`은 성공 경로에서도 ops 방에 보고합니다. 목적지는
  **언제나 운영용 방**이지 독자가 있는 채널이 아닙니다.

### 사람만 돌리는 명령

아래는 스케줄러가 **한 번도 부르지 않는**, 사람이 판단해서 손으로 돌리는 명령입니다. 스케줄러가
멈춘 것처럼 보인다면 이것들이 밀린 건 아닌지 먼저 보세요.

| 명령 | 왜 사람만 |
| --- | --- |
| `pnpm tm:pair` / `pnpm tm:promote` | 번역 메모리에 선례를 넣는 일 — 무엇이 좋은 선례인지가 판단입니다. `translate:align`은 선례가 모자라면 힌트만 찍고 넘어갑니다. |
| `pnpm collect:reference` | 참조 코퍼스 수집. 매주 돌리면 압도적으로 과거 데이터에 twitterapi.io 예산을 씁니다. 대신 `glossary:mine`이 28일 지난 코퍼스를 **말합니다**(등급이 전부 B로 떨어집니다). 돌린 뒤에는 `bash deploy/herald-deploy.sh`까지 해야 스케줄러 쪽 트리에 닿습니다. |
| `pnpm glossary add …` | 용어집 항목 확정. `glossary:mine`은 **후보만** 제안하고 용어집에는 한 줄도 쓰지 않습니다 — 넣는 건 사람입니다. |
| `pnpm format --refine` | 렌더링 다듬기 워크시트. `herald-convert`가 매 tick 돌리는 건 **`format --only-missing`**뿐이고, 이 둘은 같이 쓸 수 없습니다(`--only-missing`을 `--refine`과 함께 주면 명령이 거부합니다). 옵션 없는 `pnpm format`은 2차 검수의 수정과 승인을 **전부 덮어씁니다.** |
| `pnpm collect-lark` | Lark 그룹 채팅 수집. `herald-watch`는 X만 수집합니다 — 이걸 안 돌리면 Lark 쪽만 조용히 멈추고 보드는 정상으로 보입니다. |

## `herald-translate-check`: 조용한 주가 정상입니다

다른 넷과 성질이 하나 다릅니다. **깨끗한 한 주에는 메시지가 아예 오지 않습니다.**
`translate:check`의 오버라이드 알림도 `glossary:mine`의 후보 알림도 보고할 게 없으면 아무것도
반환하지 않고, 두 명령 모두 발견 항목이 있어도 종료 코드는 0입니다. 즉 **"다 괜찮다"가 아니라
"할 말이 없다"** 쪽으로 조용합니다.

그래서 **깨끗한 한 주와 죽은 타이머가 겉으로 구분되지 않습니다.** 둘을 가르는 건
`OnFailure=herald-notify-failure@%n.service` 하나뿐이고, 주 1회 주기에서는 그 침묵이 이레씩
갑니다. 알림이 없는 주가 이어지면 `systemctl --user list-timers`로 다음 발화 시각을 한 번 보는
게 이 유닛에서는 값을 합니다.

## 다음으로

- 각 스케줄러의 설치·확인·정지, 배치 크기 조정, 사고 대응 → [`team-runbook.md`](team-runbook.md) §6
  ([여섯 개를 한꺼번에 멈추는 법](team-runbook.md#멈추기)도 거기 있습니다 — `stop`은 글롭을 받고
  `disable`은 받지 않습니다)
- 명령이 정확히 무엇을 읽고 쓰는지 → [`artifacts.md`](artifacts.md)
- 파이프라인이 무엇을 하고 무엇을 하지 않는지 → [`capabilities.md`](capabilities.md)
