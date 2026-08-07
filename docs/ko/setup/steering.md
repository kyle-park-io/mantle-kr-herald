# 스티어링 설정 받기 (steering.md)

`translation/`과 `conversion/`에 있는 파일들을 **스티어링 설정**이라고 부릅니다. 번역·변환 프롬프트에
그대로 실려 들어가서 **결과물의 품질을 결정하는 파일들**입니다.

이 파일들은 **git에 없습니다.** 저장소를 새로 받으면 존재하지 않습니다.

## 1. 왜 git에 없나

- 이 저장소는 **공개(public)** 입니다. 팀 용어집과 승인된 번역 예시가 그대로 공개됩니다.
- 검수하면서 승인할 때마다 few-shot 파일이 자동으로 늘어납니다. 추적되면 일상적인 승인이
  매번 워킹트리를 더럽힙니다.

추적되는 것은 `*.example.*` 스켈레톤뿐입니다. 실제 파일은 `.gitignore`로 제외됩니다.

### 어떤 파일이 자동으로 갱신되나 (자동 vs 수기)

| 파일 | 갱신 방식 |
| --- | --- |
| `translation/few-shot.json` | **자동** — `translate:save --approve` 시 예시로 승격 |
| `conversion/few-shot.{x,announcement,explainer,casual,kol,pr}.json` | **자동** — 대시보드 2차 검수에서 승인할 때 승격 |
| `translation/tm.json` | **반자동** — `tm:promote`(사람이 pair를 확인한 뒤) |
| `translation/glossary.json` | **수기** — `pnpm glossary add …` 또는 직접 편집 |
| `translation/style-guide.md` · `locale.json` · `conversion/*.md` · `checklist.*.md` | **수기** — 직접 편집만 |

few-shot(자동 성장분)만 승인으로 자라고, 용어집·문체·로케일·채널 지침은 **의도적으로 사람이 큐레이션**합니다
(승인된 번역에서 용어를 자동 추출하면 잘못된 역어가 섞일 수 있어서). 자동으로 자라는 만큼 §6 백업이 중요합니다.

## 2. 어떻게 받나 — 두 갈래입니다

### 외부·오픈소스 사용자

```bash
pnpm config:init
```

`*.example.*`를 복사해 실제 파일을 만들어 줍니다. **내용은 비어 있거나 일반적인 뼈대입니다** —
용어집은 `[]`, 스타일 가이드는 항목 제목만 있습니다. 여기에 **여러분 팀의 규칙을 채워 넣어** 쓰면
됩니다. 이게 정상 경로입니다.

### Mantle KR 팀원

> ⚠️ **`pnpm config:init`을 실행하지 마세요.** 빈 스켈레톤이 생기고, `pnpm doctor`는
> "파일이 있다"며 **✓ 를 띄웁니다.** 그 상태로 번역하면 팀 용어집·문체 규칙이 하나도 적용되지
> 않은 결과가 나오는데, 아무 경고도 나지 않습니다.

팀 담당자에게 **실제 파일 19개를 받으세요.** 압축해서 전달받아 저장소 루트에 그대로 풉니다.

```
translation/glossary.json          conversion/x.md
translation/style-guide.md         conversion/announcement.md
translation/locale.json            conversion/explainer.md
translation/few-shot.json          conversion/casual.md
translation/tm.json                conversion/kol.md
                                   conversion/pr.md
                                   conversion/few-shot.{x,announcement,explainer,casual,kol,pr}.json
                                   conversion/checklist.{x,announcement}.md
```

정확한 목록은 `pnpm config:push`가 묶는 파일과 같습니다 — `translation/`과 `conversion/`에서
`*.example.*`를 뺀 전부입니다.

## 3. 제대로 받았는지 확인

`pnpm doctor`는 **파일이 있는지만** 봅니다. 내용이 비었는지는 모릅니다. 그러니 직접 확인하세요.

```bash
pnpm glossary          # "glossary: N entries" — N이 두 자리여야 정상. 0이면 스켈레톤입니다.
wc -l translation/style-guide.md conversion/x.md conversion/announcement.md
```

용어집이 `0 entries`이거나 스타일 가이드가 열 줄 남짓이면 **스켈레톤을 받은 것**입니다. 다시
요청하세요.

## 4. 원본·정본

스티어링 파일은 KR 팀 지침에서 2026-07-21에 초기 이관해 온 것이고, 각 파일 맨 위 `> 출처:` 줄에
그 사실이 적혀 있습니다.

**이 저장소의 파일이 정본입니다** — 규칙이 바뀌면 **여기를 고치세요.** 다른 곳에 사본을 두고 그쪽을
정본으로 삼지 마세요: 승인으로 자동으로 자란 few-shot은 이 저장소에만 있고, 정기 백업은 §6의
`config:push`(→ Google Drive)가 담당합니다.

> 이관 원본을 가리키던 Lark 링크는 2026-08-08에 전부 제거했습니다(스티어링 파일 6개의 `출처` 줄과
> `glossary.json` 42개 항목의 `source`). 아무도 그 문서를 정본으로 쓰고 있지 않았고, 살아 있는 링크는
> 고쳐야 할 곳이 두 군데인 것처럼 보이게 만들 뿐이었습니다. `glossary.json`의 나머지 `source`(mantle.xyz,
> tangem 등 실제 참고 자료)는 그대로 둡니다.

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

git은 더 이상 이 파일들을 지켜주지 않고(의도한 설계) few-shot 플라이휠로 계속 자라므로, **정기 백업이
필요합니다.**

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
