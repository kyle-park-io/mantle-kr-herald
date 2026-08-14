# 게시됨이 렌더보다 먼저 도착하면, 2차 검수는 열리지 않는다

`x:reconcile`이 아이템을 `posted`로 닫는 순간부터 `FormatVariants`는 그 아이템의 채널 카드를 만들지
않습니다(`src/app/FormatVariants.ts:120-177`). 의도된 규칙입니다 — 끝난 일감이 30분마다 2차 검수
보드에 되살아나는 것을 막으려고 넣었습니다(#196 이전의 세 아이템).

문제는 **카드가 만들어지기도 전에** 그 규칙이 걸리는 경우입니다. 그러면 규칙이 막는 것은 되살아나는
카드가 아니라, 한 번도 존재한 적 없는 카드입니다. 사람은 2차 검수를 할 기회 자체를 얻지 못하고,
어디에도 그 사실이 남지 않습니다.

2026-08-14 프로덕션에서 `x:2087919535311757788`이 그렇게 됐습니다. 이 문서는 그 한 건의 기록이고,
아직 고치지 않았습니다.

## 무슨 일이 있었나

전부 로그와 프로덕션 DB에서 확인한 값입니다. 시각은 UTC.

| 시각 | 무슨 일이 | 근거 |
|---|---|---|
| 08-13 15:19–17:21 | 번역 + 수정 3회 | `lineage` |
| 08-14 01:06:23 | 한국 X 게시물이 **손으로** 올라감 | `translations.posted_at` |
| 08-14 01:06:32 | 1차 검수 승인 | `translations.approved_at` |
| 08-14 01:12:23 → **01:12:34** | `herald-x-reconcile` — 라이브 글을 승인된 번역문과 **0.900**으로 매칭해 게시됨 처리. **11초** | `~/.herald/logs/herald-x-reconcile/20260814T011223Z.log:67` |
| 08-14 01:12:23 → 01:20:43 | `herald-convert` — 같은 초에 함께 뜸. 7개 타입을 01:16:21–01:20:15에 저장한 뒤 format 직전에 실패 (`claude -p was denied permission for: Bash`) | `~/.herald/logs/herald-convert/20260814T011223Z.log:4` |
| 08-14 01:37:10 → 01:41:33 | 다음 변환 틱이 `convert:prepare → status → status → format` 정상 완주 — 그러나 이미 `posted`라 전량 skip | `~/.herald/logs/herald-convert/20260814T013710Z.log:4` |

결과: `variants` 7행, `renderings` **0행**.

두 가지를 분명히 해 둡니다.

**게시됨은 변환 원고보다 먼저였습니다.** 01:12:23에 닫혔고 원고는 01:16:21에 처음 생겼습니다. 즉
"렌더가 늦었다"가 아니라 "변환 자체가 늦었다"입니다. 렌더 단계만 손봐서는 못 막습니다.

**렌더가 없어도 게시됨은 성립합니다.** `posted` 버킷은 렌더가 아니라 **번역문**을 비교합니다
(`TRANSLATION_MATCH_AT = 0.25`, `src/domain/publish/xReconcile.ts:59`). 이건 #125에서 의도적으로
넣은 경로입니다 — 사람이 번역문을 그대로 붙여넣고 올리는 게 가장 흔한 손게시 모양이라서요. 그래서
"카드가 하나도 없다"는 사실이 방어가 되지 않습니다.

## 왜 타이머 분산이 막지 못했나

세 타이머의 분(minute)은 **일부러** 어긋나게 잡혀 있습니다.

| 유닛 | OnCalendar | 주기 |
|---|---|---|
| `herald-convert` | `*-*-* *:07,37:00` | 30분 |
| `herald-watch` | `*-*-* 0/2:17:00` | 2시간 |
| `herald-x-reconcile` | `*-*-* 0/6:41:00` | 6시간 |

이유는 `deploy/herald-convert.timer` 헤더에 적혀 있습니다 — 셋 다 같은 체크아웃에서 같은 DB를 상대로
`pnpm`을 돌리고 둘은 `claude -p`를 띄우므로, 분을 공유해서 얻을 게 없다. `tests/deploy/convertTiming.test.ts`와
`tests/deploy/xReconcileTiming.test.ts`가 이 분리를 어서션으로 못박아 두기까지 했습니다.

**그 분리를 `Persistent=true`가 무효로 만듭니다.** 세 유닛 모두 켜져 있고, 이유도 타당합니다 —
WSL2에서 user manager가 안 떠 있는 사이 예정된 발사를 통째로 건너뛰는 걸 막으려고 넣었습니다. 대신
머신이 돌아오면 밀린 타이머가 **같은 순간에 한꺼번에** 발사됩니다. 01:12:23에 convert · x-reconcile ·
backup · creds 네 개가 동시에 뜬 게 그것입니다(`systemctl --user list-timers`의 LAST 열에 지금도 남아
있음). OnCalendar의 분은 이 경로에서 아무 의미가 없습니다.

그리고 이 경주는 한쪽으로 기울어 있습니다. reconcile은 **11초**에 끝나고, 변환 틱은 format까지
**4분 23초**(01:37:10→01:41:33, 정상 완주 기준)가 걸립니다. 동시에 출발하면 게시됨이 항상 이깁니다.

### 부차적으로: 정상 스케줄도 아슬아슬합니다

6시간마다 한 번, convert의 `:37` 발사와 reconcile의 `:41` 발사가 겹칩니다. `:37 + 4분 23초 = :41:33`
이니 reconcile이 `:41:00`에 출발하는 그 순간 변환 틱은 아직 format 단계에 있습니다. 이번 사고의 원인은
아니지만, 캐치업만 고치면 이쪽이 남습니다.

## 무엇을 잃었나 — 지금까지 1건

프로덕션 전수 조사입니다. `posted`이면서 변환 원고는 있는데 렌더가 하나라도 빈 아이템:

```sql
select t.item_id, t.posted_at,
       count(distinct v.type) as variants,
       count(distinct r.type) as rendered_types
  from translations t
  join variants v on v.item_id = t.item_id
  left join renderings r on r.item_id = t.item_id
 where t.status = 'posted'
 group by t.item_id, t.posted_at
having count(distinct v.type) > count(distinct r.type);
```

2026-08-14 기준 **`x:2087919535311757788` 한 건**뿐이고, 그 한 건은 7개 타입 전부를 잃었습니다.
만성적인 유실이 아니라 첫 발생입니다 — 급한 불은 아니라는 뜻이고, 그래서 아래 선택지 중 가장 싼 것도
정당한 답이 됩니다.

잃은 원고 두 개는 `output/xstocks/kakao-telegram-xstocks-rwa.md`로 복구해 뒀습니다(저장소 함수로 재생성,
대시보드 [복사]와 같은 경로). `output/`은 gitignore이므로 그 파일은 이 노트북에만 있습니다.

## 어디를 고칠 수 있나

셋 다 배타적이지 않습니다. C는 A·B 중 무엇을 고르든 같이 하는 편이 낫습니다.

### A. 캐치업 순서를 강제한다 — `After=herald-convert.service`

`herald-x-reconcile.service`에 `After=herald-convert.service`를 걸면, **같은 트랜잭션에서 함께 시작할
때만** 순서가 생깁니다. 캐치업 스톰이 정확히 그 경우이고, 정상 스케줄에서는 두 유닛이 별개
트랜잭션이라 아무 일도 하지 않습니다. 부작용이 좁다는 게 장점입니다.

- 두 유닛 다 `Type=oneshot`이므로 `After=`는 **종료까지** 기다립니다. 확인함.
- 비용: convert가 늦으면 reconcile도 그만큼 밀립니다. `TimeoutStartSec=840`(convert) 만큼이 상한.
- 한계: 스케줄만 고칩니다. 손으로 `pnpm x:reconcile`을 돌리거나 대시보드 **게시됨으로**를 누르면
  그대로 같은 구멍입니다.
- 위 "정상 스케줄도 아슬아슬" 건은 안 고쳐집니다. convert의 `:37`을 앞당기거나 reconcile을 `:41`에서
  옮기는 게 별도로 필요하고, 그러면 위 두 타이밍 테스트도 같이 손봐야 합니다.

### B. 렌더 없는 변환이 남은 아이템은 닫지 않는다 — 도메인 쪽

`RetireTranslation`이 상태를 뒤집기 **전에** 그 아이템의 (variant, 기본 채널) 쌍 중 렌더가 없는 게
있는지 보고, 있으면 (b1) 먼저 렌더를 만든다 / (b2) 닫되 경고한다 / (b3) 닫지 않고 candidate로 넘긴다.

- 타이머 배치와 무관하게 성립합니다. 손 실행도, 대시보드 버튼도 같이 막힙니다 — **A가 못 덮는 두 경로**.
- b1은 `FormatVariants`의 posted 게이트 주석과 정면으로 부딪힙니다. 그 주석은 "posted는 모든 호출자에게
  종단"이어야 하는 이유를 길게 적어 뒀습니다. 그러니 b1을 한다면 상태를 뒤집기 전에, 같은 트랜잭션
  안에서만 해야 합니다. 순서를 틀리면 게이트에 걸려 조용히 아무것도 안 만듭니다.
- b3은 자동 은퇴의 값어치를 깎습니다 — #125가 자동화하려던 바로 그 일을 다시 사람에게 돌려줍니다.
- 대시보드 **게시됨으로**는 `RetireTranslation`이 아니라 `createDeps.ts:667`에서 직접 `posted`를 씁니다.
  B를 한다면 이 경로도 같이 봐야 합니다. **먼저 확인할 것.**

### C. 최소한 소리는 내게 한다

지금 x:reconcile의 마지막 줄은 `retired 1`까지만 말합니다. 여기에 "렌더 없이 닫힌 변환 N건"을 붙이면
유실이 조용히 지나가지는 않습니다. 막지는 못하지만, 이번 건을 사람이 알아채는 데 걸린 시간이
사실상 무한이었다는 점을 생각하면 값이 큽니다.

- 가장 쌉니다. 유실 1건짜리 문제에 A나 B의 리스크를 지불하기 전에 이것부터가 맞을 수 있습니다.
- 실패 알림 경로가 이미 있습니다(`deploy/herald-notify-failure.sh`). 다만 이건 실패가 아니라 정상 종료
  중의 경고라서, 그 경로에 태울지 요약 줄에만 남길지는 결정해야 합니다.

## 열린 질문 — 다른 노트북에서 확인할 것

1. 캐치업 스톰이 얼마나 잦은가? WSL2라 매일일 가능성이 있습니다. `~/.herald/logs/*/` 의 파일명
   타임스탬프에서 여러 유닛이 같은 초를 공유하는 날을 세면 바로 나옵니다.
2. 대시보드 **게시됨으로**(`createDeps.ts:667`)가 `RetireTranslation`을 우회하는가? B의 범위가 여기서
   갈립니다.
3. `x:reconcile`이 캐치업으로 돌 때, 그날 아직 변환도 안 된 아이템을 매칭하는 게 애초에 맞는가?
   "번역 승인 후 N분 이내는 건드리지 않는다" 같은 유예가 A·B보다 단순한 답일 수 있습니다.
4. C를 한다면 경고 문구를 어디에 태울지 — 요약 줄인지 `herald-notify-failure` 경로인지.

## 재현

```bash
# 사고 당시 로그 세 개
cat ~/.herald/logs/herald-x-reconcile/20260814T011223Z.log   # "retired — already posted by hand"
cat ~/.herald/logs/herald-convert/20260814T011223Z.log       # format 직전 실패
cat ~/.herald/logs/herald-convert/20260814T013710Z.log       # format 완주, 그러나 skip

# 캐치업 스톰의 흔적 — LAST 열이 같은 초를 공유합니다
systemctl --user list-timers --all

# 프로덕션은 ~/.herald/prod.env 를 씁니다 (저장소 .env 는 development)
set -a && . ~/.herald/prod.env && set +a
pnpm lineage --id x:2087919535311757788
```

## 참고

| | |
|---|---|
| `src/app/FormatVariants.ts:120-177` | posted 게이트 — 왜 모든 호출자에게 적용되는지 |
| `src/domain/publish/xReconcile.ts:47-59` | `TRANSLATION_MATCH_AT` 보정 근거 |
| `src/app/RetireTranslation.ts:136` | `status: "posted"` + `postedUrl`을 한 문장에 쓰는 곳 |
| `src/adapters/web/apiHandlers.ts:665` | 2차 목록에서 posted를 빼는 필터 (#196) |
| `deploy/herald-convert.timer` | 분을 어긋나게 잡은 이유 (헤더 주석) |
| `docs/superpowers/specs/2026-08-07-hand-posted-reconciliation-design.md` | #125 — 번역문 매칭 경로를 넣은 설계 |
| `output/xstocks/kakao-telegram-xstocks-rwa.md` | 이번에 잃은 공지 두 개 (gitignore, 로컬 전용) |
