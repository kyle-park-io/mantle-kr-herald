# 스티어링 설정 받기 (steering.md)

`translation/`과 `conversion/`에 있는 파일들을 **스티어링 설정**이라고 부릅니다. 번역·변환 프롬프트에
그대로 실려 들어가서 **결과물의 품질을 결정하는 파일들**입니다.

이 파일들은 **git에 없습니다.** 저장소를 새로 받으면 존재하지 않습니다.

## 1. 왜 git에 없나

- 이 저장소는 **공개(public)** 입니다. 팀 용어집과 승인된 번역 예시가 그대로 공개됩니다.
- 예전에는 검수 승인마다 few-shot 파일이 자동으로 늘어나 일상적인 승인이 매번 워킹트리를
  더럽혔습니다(지금 그 코퍼스는 데이터베이스에 있습니다 — 바로 아래).

추적되는 것은 `*.example.*` 스켈레톤뿐입니다. 실제 파일은 `.gitignore`로 제외됩니다.

### 어떤 파일이 자동으로 갱신되나 (자동 vs 수기)

| 파일 | 갱신 방식 |
| --- | --- |
| `translation/tm.json` | **반자동** — `tm:promote`(사람이 pair를 확인한 뒤) |
| `translation/glossary.json` | **수기** — `pnpm glossary add …` 또는 직접 편집 |
| `translation/glossary-dismissed.json` | **수기** — 직접 편집만. 쓰는 코드가 아예 없습니다(§1-1) |
| `translation/style-guide.md` · `locale.json` · `conversion/*.md` · `checklist.*.md` | **수기** — 직접 편집만 |

용어집·문체·로케일·채널 지침은 **의도적으로 사람이 큐레이션**합니다(승인된 번역에서 용어를 자동
추출하면 잘못된 역어가 섞일 수 있어서). 즉 이 디렉터리에서 사람 손 없이 자라는 파일은 이제
없습니다 — 그래도 이 머신에만 있는 것은 여전하므로 §6 백업은 그대로 중요합니다.

> **few-shot 코퍼스는 더 이상 이 디렉터리의 파일이 아닙니다.** 승인이 키우는 예시 모음은
> 데이터베이스의 `few_shot_examples` 테이블입니다 — `translate:save --approve`와 대시보드 2차
> 검수 승인은 `PgFewShotStore`에 쓰고, `translate:prepare`/`convert:prepare`도 거기서 읽습니다.
>
> `translation/few-shot.json`과 `conversion/few-shot.<타입>.json`이 디렉터리에 보일 수 있는데,
> 그것은 **`pnpm db:export`가 롤백용으로 써 놓은 산출물**이지 스티어링 설정이 아닙니다. 런타임에
> 읽는 코드는 없고, `pnpm config:push`도 `pnpm deploy:freeze`도 이 두 이름은 제외합니다. 지우지는
> 마세요 — `db:export` → `db:import` 롤백 경로의 입력입니다. (`tm.json`은 헷갈리기 쉽지만
> **진짜 설정**이고, 그대로 동기화됩니다.)

### 1-1. `glossary-dismissed.json` — 잃으면 조용히 되살아나는 파일

주간 `pnpm glossary:mine`(용어집 후보 발굴, [`capabilities.md`](../capabilities.md) §6)은 커서도
"본 적 있음" 상태도 없습니다. 매주 원장 전체를 다시 훑어 후보를 새로 뽑기 때문에, **아니라고 판단한
후보를 어딘가 적어 두지 않으면 같은 줄이 영원히 다시 옵니다** — 그러면 알림은 아무도 안 읽는
잡음이 됩니다. 그 "아니오"를 적는 곳이 이 파일입니다.

```json
[
  { "term": "규모 → 사이즈", "note": "코퍼스가 우리 초안 편. 1회성 교정", "dismissedAt": "2026-08-11" },
  { "term": "Mentor Clinic", "note": "이벤트 이름이라 매번 달라짐", "dismissedAt": "2026-08-11" }
]
```

`term`에는 검토 파일의 각 후보에 붙은 `_후보` 값을 그대로 넣으세요(대소문자와 공백은 알아서
맞춥니다). 쓰는 코드는 없습니다 — 파이프라인이 스스로 후보를 잠재울 수 있으면 이 파일을 믿을 수
없게 되므로, 편집기로 사람이 적는 것이 유일한 경로입니다. 다른 스티어링 파일과 똑같이
`config:push`/`config:pull`/`deploy:freeze`가 함께 나릅니다.

## 2. 어떻게 받나 — 두 갈래입니다

### 외부·오픈소스 사용자

```bash
pnpm config:init
```

`*.example.*`를 복사해 실제 파일을 만들어 줍니다. **내용은 비어 있거나 일반적인 뼈대입니다** —
용어집은 `[]`, 스타일 가이드는 항목 제목만 있습니다. 여기에 **여러분 팀의 규칙을 채워 넣어** 쓰면
됩니다. 이게 정상 경로입니다.

### Mantle KR 팀원

> ⚠️ **`pnpm config:init`을 실행하지 마세요.** 빈 스켈레톤이 생깁니다. 지금은 `pnpm doctor`가
> 그 상태를 `warn`으로 잡아 주지만(§3), 팀 파일을 받기 전에 스켈레톤부터 깔아 두면 `config:init`은
> **이미 있는 파일을 덮어쓰지 않으므로** 나중에 진짜 파일을 풀 때 뭘 덮어써야 하는지 헷갈립니다.

팀 담당자에게 **실제 파일 14개를 받으세요.** 압축해서 전달받아 저장소 루트에 그대로 풉니다.

```
translation/glossary.json             conversion/x.md
translation/glossary-dismissed.json   conversion/announcement.md
translation/style-guide.md            conversion/kakao_notice.md
translation/locale.json               conversion/explainer.md
translation/tm.json                   conversion/casual.md
                                      conversion/kol.md
                                      conversion/pr.md
                                      conversion/checklist.{x,announcement}.md
```

정확한 목록은 `pnpm config:push`가 묶는 파일과 같습니다 — `translation/`과 `conversion/`에서
`*.example.*`와 `few-shot*.json`(§1의 `db:export` 산출물)을 뺀 전부입니다. few-shot 코퍼스는 이
꾸러미에 들어 있지 않아도 됩니다 — 데이터베이스에 있습니다.

## 3. 제대로 받았는지 확인

`pnpm doctor`는 존재 여부만 보지 않습니다. **내용도 봅니다** — 용어집이 빈 배열(`[]`)이거나 가이드가
아직 `*.example.*` 스켈레톤과 글자 그대로 같으면 `Steering config`를 `warn`으로 내리고 어느 파일인지
이름을 찍습니다(`present but empty: …`, `src/doctor/steering.ts`의 `skeletonSteeringFiles`).
파일이 아예 없으면 그건 `fail`입니다.

다만 `doctor`가 잡는 것은 **"스켈레톤 그대로냐"** 까지입니다. 스켈레톤에서 한 줄만 고쳐 놓아도
`ok`가 되므로, 실제로 쓸 만한 내용인지는 눈으로 확인하세요.

```bash
pnpm doctor            # Steering config가 ✓ 인지, present but empty 경고가 붙는지
pnpm glossary          # "glossary: N entries" — N이 두 자리여야 정상. 0이면 스켈레톤입니다.
wc -l translation/style-guide.md conversion/x.md conversion/announcement.md conversion/kakao_notice.md
```

용어집이 `0 entries`이거나 스타일 가이드가 열 줄 남짓이면 **스켈레톤을 받은 것**입니다. 다시
요청하세요.

## 4. 원본·정본

스티어링 파일은 **KR 팀 Lark 문서에서 초기 이관**해 온 것이고, 각 파일 맨 위 `> 출처:` 줄에 그 Lark
링크가 적혀 있습니다.

**이 저장소의 파일이 정본입니다** — 규칙이 바뀌면 **여기를 고치세요.**

위 Lark 문서는 **이관 시점의 초기 레퍼런스**입니다. 거기를 고쳐서 되돌리는 흐름은 없습니다 —
갱신은 언제나 이쪽이고, 밖으로 나가는 것은 §6의 `config:push` 스냅샷입니다. 방향이 한쪽인 이유는
단순합니다: 정본이 두 군데면 어느 쪽이 최신인지 아무도 모르게 됩니다.

**고쳤으면 바로 `pnpm config:push`를 돌리세요.**

```bash
pnpm config:push
```

이 디렉터리는 git이 추적하지 않습니다. 그래서 고친 내용은 **이 머신에만** 있고, 커밋도 PR도 되돌리기도
없습니다. Drive 스냅샷이 이 변경의 유일한 사본이며, 밀기 전까지는 그마저 없습니다.

§6에는 이 명령이 "정기 백업"으로 적혀 있었고, 그래서 편집과 백업이 서로 다른 일처럼 읽혔습니다.
2026-08-08에 어투 규칙(`locale.json`의 `honorific`, 그리고 `style-guide.md`의 대응 문장)을 고치고도
밀지 않아, 한동안 이 머신에만 존재했습니다 — 그 일이 이 문단을 여기에 쓰게 만들었습니다. 편집한
사람이 곧 미는 사람입니다.

### 스케줄러가 도는 머신이라면 — 고친 것은 배포해야 반영됩니다

스케줄 유닛은 이 저장소가 아니라 **배포 체크아웃**(`~/.herald/app`)에서 돕니다. 스티어링 설정도
`bash deploy/herald-deploy.sh`가 배포할 때 거기로 **복사**해 넣습니다. 그래서 여기서 용어집을
고치고 배포를 안 하면, 다음 타이머 발화는 **옛 용어집으로 번역합니다** — 오류도, 경고도, 틀려
보이는 결과물도 없이(적용되지 않은 용어는 그냥 없을 뿐입니다).

```bash
pnpm doctor      # Steering deploy sync — 두 트리가 어긋나면 이름만 ⚠ 로 알려줍니다
```

이 줄은 두 체크아웃의 스티어링 설정을 비교해 **파일 이름만** 출력하고(값은 절대 출력하지 않습니다),
어느 쪽이 정본이고 어느 쪽을 스케줄러가 돌리는지 경로로 적습니다. 목록을 뽑는 코드는
`deploy:freeze`와 같은 것이라 §2의 규칙이 그대로 적용됩니다 — `few-shot*.json`은 여기서도 비교
대상이 아닙니다. 어긋나 있으면 `bash deploy/herald-deploy.sh`를 돌리면 됩니다. 배포 체크아웃이 없는
머신(새 클론, 팀원 노트북, CI)에서는 `not applicable`이라고만 적고 넘어갑니다 — 자세한 건
[team-runbook의 "배포 체크아웃"](../team-runbook.md#배포-체크아웃--스케줄러는-개발-트리에서-돌지-않습니다) 절에
있습니다.

> **참조 코퍼스(`output/x/reference/`)는 이 비교에 들어 있지 않습니다 — 일부러입니다.** 그것은
> 스티어링 설정이 아니라 데이터이고, 저장소가 아니라 `OUTPUT_DIR` 아래에 있으며(목적지도
> `~/.herald/output/x/reference`로 배포 체크아웃 바깥입니다), 두 트리가 다르다는 것이 "틀렸다"가
> 아니라 "오래됐다"는 뜻입니다. 오래됐는지는 `glossary:mine`이 코퍼스에 들어 있는 수집 원장을 읽어
> 28일 기준으로 직접 말합니다(해시 비교보다 정확한 근거입니다 — 똑같이 낡은 두 트리는 해시가
> 같습니다). 옮기는 일은 배포의 별도 단계(`deploy/herald-copy-corpus.sh`)가 맡습니다. 자세한 판단
> 근거는 `src/doctor/deploySteering.ts` 머리말에 적혀 있습니다.

> **처음 한 번은 `few-shot*.json` 이름이 뜰 수 있는데, 고장이 아닙니다.** 2026-08-11 전에 배포한
> 머신의 `~/.herald/app`에는 그때 얼려 둔 few-shot 사본 일곱 개가 남아 있습니다. 이제 이쪽에서
> 안 보내는 파일이라 배포 트리에만 있는 상태가 되고, doctor는 그걸 `⚠`가 아니라 `✓`로 —
> "스케줄러가 읽는 것은 아무것도 다르지 않고, 다음 배포가 쓸어낸다"고 적습니다. 실제로 다음
> `bash deploy/herald-deploy.sh`가 `remove:` 줄과 함께 지웁니다.

## 5. 잃어버렸을 때

`git pull` 한 번에 사라진 적이 실제로 있습니다([`CHANGELOG.md`](../../../CHANGELOG.md) 상단
업그레이드 노트). 이 파일들이 추적 대상에서 빠지던 그 커밋에서 벌어진 일입니다.

**`pnpm config:init`은 이 상황의 복구 방법이 아닙니다** — 스켈레톤으로 조용히 덮어씁니다.

**Drive 스냅샷이 있으면 `pnpm config:pull`이 1순위 복원입니다**(§6 — 최신 스냅샷을 그대로 되살림).
스냅샷이 없거나 `config:push` 이전 데이터라면, 저장소 히스토리에 마지막으로 추적되던 시점에서 되살립니다.

```bash
# <커밋> = 파일들이 아직 추적되던 마지막 커밋
for f in $(git ls-tree -r --name-only <커밋> translation conversion | grep -v '\.example\.'); do
  git show "<커밋>:$f" > "$f"
done
```

되살린 뒤에는 §3으로 내용을 반드시 확인하세요.

## 6. 백업

git은 더 이상 이 파일들을 지켜주지 않고(의도한 설계) 이 머신 한 대에만 있으므로, **정기 백업이
필요합니다.** few-shot 플라이휠은 이제 데이터베이스에 있어 이 백업의 대상이 아닙니다 — 그쪽은
`pnpm state:push`/`db:export`가 챙깁니다.

**권장 — Google Drive 스냅샷 (`config:push`/`config:pull`):**

```bash
pnpm config:push              # 스티어링 전체를 Drive에 타임스탬프 스냅샷으로 백업
pnpm config:pull --dry-run    # 최신 스냅샷과 로컬의 차이 미리보기
pnpm config:pull              # 최신 스냅샷으로 복원 (덮어쓰기 전 output/archive/steering-<stamp>/에 로컬 백업)
```

스냅샷은 **덮어쓰지 않고 히스토리로 쌓여** 이전 상태로 롤백할 수 있습니다. 처음 `config:push`는 Drive의
`Mantle KR Herald` 폴더 밑에 `steering-config` 폴더를 만들고 id를 알려주니 `.env`의
`GDRIVE_CONFIG_FOLDER_ID`에 넣으세요. (팀원이 `config:pull`하려면 push한 사람과 **같은 Google
자격증명**을 쓰거나 OAuth 스코프를 `drive.file`→`drive`로 넓혀야 합니다 — `drive.file`은 그 자격증명이
만든 파일만 보이기 때문입니다.)

**오프라인 사본(추가):**

```bash
cp -r translation conversion ~/mantle-steering-backup-$(date +%Y%m%d)/
```
