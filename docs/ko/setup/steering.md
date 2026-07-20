# 스티어링 설정 받기 (steering.md)

`translation/`과 `conversion/`에 있는 파일들을 **스티어링 설정**이라고 부릅니다. 번역·변환 프롬프트에
그대로 실려 들어가서 **결과물의 품질을 결정하는 파일들**입니다.

이 파일들은 **git에 없습니다.** 저장소를 새로 받으면 존재하지 않습니다.

## 1. 왜 git에 없나

- 이 저장소는 **공개(public)** 입니다. 팀 용어집과 승인된 번역 예시가 그대로 공개됩니다.
- 검수하면서 승인할 때마다 few-shot 파일이 자동으로 늘어납니다. 추적되면 일상적인 승인이
  매번 워킹트리를 더럽힙니다.

추적되는 것은 `*.example.*` 스켈레톤뿐입니다. 실제 파일은 `.gitignore`로 제외됩니다.

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

팀 담당자에게 **실제 파일 10개를 받으세요.** 압축해서 전달받아 저장소 루트에 그대로 풉니다.

```
translation/glossary.json          conversion/x.md
translation/style-guide.md         conversion/announcement.md
translation/locale.json            conversion/kol.md
translation/few-shot.json          conversion/pr.md
                                   conversion/few-shot.{x,announcement,kol,pr}.json
                                   conversion/checklist.{x,announcement}.md
```

## 3. 제대로 받았는지 확인

`pnpm doctor`는 **파일이 있는지만** 봅니다. 내용이 비었는지는 모릅니다. 그러니 직접 확인하세요.

```bash
pnpm glossary          # "glossary: N entries" — N이 두 자리여야 정상. 0이면 스켈레톤입니다.
wc -l translation/style-guide.md conversion/x.md conversion/announcement.md
```

용어집이 `0 entries`이거나 스타일 가이드가 열 줄 남짓이면 **스켈레톤을 받은 것**입니다. 다시
요청하세요.

## 4. 원본은 어디 있나

스티어링 파일은 **KR 팀 Lark 문서에서 이관해 온 것**이고, 그 Lark 문서가 정본입니다. 각 파일 맨 위
`> 출처:` 줄에 원본 링크가 적혀 있습니다.

규칙이 바뀌면 **Lark를 먼저 고치고**, 그 다음 이 파일에 반영합니다. 반대로 하면 다음에 파일을 다시
받는 사람이 옛 규칙을 받게 됩니다.

## 5. 잃어버렸을 때

`git pull` 한 번에 사라진 적이 실제로 있습니다([`CHANGELOG.md`](../../../CHANGELOG.md) 상단
업그레이드 노트). 이 파일들이 추적 대상에서 빠지던 그 커밋에서 벌어진 일입니다.

**`pnpm config:init`은 이 상황의 복구 방법이 아닙니다** — 스켈레톤으로 조용히 덮어씁니다.
저장소 히스토리에 마지막으로 추적되던 시점이 남아 있으니 거기서 되살립니다.

```bash
# <커밋> = 파일들이 아직 추적되던 마지막 커밋
for f in $(git ls-tree -r --name-only <커밋> translation conversion | grep -v '\.example\.'); do
  git show "<커밋>:$f" > "$f"
done
```

되살린 뒤에는 §3으로 내용을 반드시 확인하세요.

## 6. 백업

**저장소 밖에 사본을 두세요.** git은 더 이상 이 파일들을 지켜주지 않습니다 — 의도한 설계입니다.
승인이 쌓일수록(few-shot 플라이휠) 저장소 히스토리의 마지막 스냅샷과 멀어지므로, 히스토리 복구는
그 시점까지만 되돌려 줍니다.

```bash
cp -r translation conversion ~/mantle-steering-backup-$(date +%Y%m%d)/
```
