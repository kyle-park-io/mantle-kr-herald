# 카톡 공지 — 카카오에 자기 원고를 준다

## 왜

지금 공지 하나를 텔레그램(4096자)과 카카오(500자)가 나눠 씁니다. 텔레그램 기준으로 쓰이니 카카오에서 접힙니다 — 실측으로 `x:2087156149368082696`의 카카오 렌더링이 **900자**, 상한의 1.8배입니다. 여기에 어제 붙인 X 링크 CTA가 **73자**를 더 먹습니다.

카카오는 **무조건 한 통**이고 **500자가 한계**입니다. 나누지 않습니다. 그러니 카카오는 자기 원고를 받아야 합니다.

## 무엇

새 변환 타입 `kakao_notice`(화면 표기 **카톡 공지**) 하나. `announcement`는 텔레그램만, `kakao_notice`는 카카오만 맡습니다.

| 타입 | 채널 | 상한 |
|---|---|---|
| `announcement` | telegram | 4096 |
| `kakao_notice` | kakao | **500 (CTA 포함)** |

X 링크 CTA는 두 타입 다 유지합니다 — 텔레그램 `➡`, 카카오 `👉`. 팬아웃이 갈라지므로 각 타입은 자기 채널의 아이콘만 만나게 됩니다.

이미 저장된 `(announcement, kakao)` 렌더링은 **건드리지 않습니다.** 새로 만들어지지 않을 뿐, 보드는 저장된 행에서 그리므로 기존 아이템에는 계속 보입니다. 마이그레이션 없음 — 사용자 결정.

## 범위 밖

- 500자 초과를 [복사] 차단으로 막지 않습니다. 카카오는 사람이 붙여넣는 채널이고, emitter가 이미 `overLimit`을 세워 화면에 경고를 띄웁니다. 상한은 **가이드로 조종하고 경고로 보여줍니다.**
- 기존 렌더링 정리/마이그레이션.

---

## Task 1: 타입을 파이프라인 전체에 심는다

한 번에 다 들어가야 합니다 — 절반만 넣으면 타입 체크는 통과하는데 화면에서 조용히 사라집니다(`tests/web/typeMirror.test.ts:66-72`가 기록하는 실제 사고).

**Files:**
- `src/domain/conversion/models.ts:12,13` — 유니온과 `ALL_TYPES`에 `kakao_notice` 추가. **`announcement` 바로 뒤** — 이 배열 순서가 보드 카드 정렬 순서(`board.ts:111`)이자 목록 필터 순서(`RenderingList.tsx:65`)입니다.
- `src/domain/conversion/models.ts:27-34` — `LABELS`에 `kakao_notice: "카톡 공지"`. tsc가 강제합니다.
- `src/domain/conversion/models.ts:7-10` — 모듈 주석이 "The four Telegram-bound types"라고 세고 있습니다. 숫자와 설명을 고치세요.
- `src/domain/formatting/models.ts:12-19` — `announcement: ["telegram"]`로 줄이고 `kakao_notice: ["kakao"]` 추가. 7-10행 주석이 "an `announcement` is written once and carried by both Telegram and KakaoTalk"라고 약속하고 있으니 같이 고칩니다 — **이제 그 문장이 이 변경의 정반대입니다.**
- `src/domain/outlet/models.ts:45,46` — `kakao-blockchain`, `kakao-kol`의 `suggestedTypes`를 `["kakao_notice"]`로. 이걸 빠뜨리면 아무도 안 깨지고 카카오 카드에 기본 방이 0개로 뜹니다.
- `src/domain/formatting/xLinkCta.ts:39-42` — `needsXLinkCta`가 두 타입을 받게. 집합으로 표현하고, 왜 채널 검사와 타입 검사가 둘 다 필요한지(팬아웃이 이미 갈라도 이 술어는 저장된 행에도 물어봅니다) 주석으로 남기세요.
- `web/src/types.ts:140,146` — `ALL_TYPES`와 `TYPE_LABEL` 미러. **순서까지 동일해야** 합니다(`typeMirror.test.ts:82-84`).

**고쳐야 할 기존 테스트** (전부 실패로 드러납니다):
- `tests/domain/formatting/models.test.ts:7` — `DEFAULT_CHANNELS_BY_TYPE.announcement`가 이제 `["telegram"]`. `kakao_notice`도 검증 추가.
- `tests/domain/formatting/xLinkCta.test.ts:19-27` — `needsXLinkCta("announcement","kakao")`는 이제 **false**여야 맞습니다(그 조합은 더 이상 생기지 않음). `("kakao_notice","kakao")`가 true. 루프 목록에도 새 타입 반영.
- `tests/domain/send/sendBlock.test.ts:84,92` — 같은 이유로 `xUrlBlock` 기대값 조정.
- `tests/adapters/web/board.test.ts:109` — `unconverted` 리터럴 목록에 새 타입.
- `tests/app/convertTick.test.ts:82` — usage 문자열 리터럴(`ALL_TYPES.join("|")`에서 생성됨).
- `tests/web/typeMirror.test.ts` — 미러가 맞으면 저절로 통과.
- `tests/domain/conversion/promptAssembler.test.ts:31-38` — 라벨·채널·few-shot 저장소 존재를 강제하는 관문.

**주의 — 조용히 의미가 바뀌는 테스트:** 어제 두 번 겪었습니다. 통과하는 테스트 중 `announcement` + `kakao` 조합을 픽스처로 쓰는 것이 있으면, 그 조합은 이제 파이프라인이 만들지 않는 상태입니다. 실패하지 않더라도 찾아서 새 타입으로 옮기거나 주석으로 이유를 남기세요.

**검증:** `pnpm test` 와 `pnpm typecheck` 둘 다. 별개 관문입니다 — vitest는 타입을 안 봅니다.

---

## Task 2: 카카오 emitter — 나누라는 말을 지운다

**Files:** `src/domain/formatting/emitters/kakao.ts`, `tests/domain/formatting/emitters/kakao.test.ts`

지금 경고가 이렇습니다:

```
${length}/${KAKAO_FOLD}자 — 「전체보기」로 접힙니다. 나누는 것을 권합니다
```

**카카오는 나누지 않습니다.** 이 문구가 검수자에게 나누라고 시키는 유일한 출처입니다(코드는 이미 `flattenPostBoundaries`로 항상 한 통을 냅니다). 줄이라고 바꾸세요 — 예: `${length}/${KAKAO_FOLD}자 — 「전체보기」로 접힙니다. 카카오는 한 통으로 나가니 줄여야 합니다`.

`KAKAO_FOLD = 500` 값과 그 위의 카카오 CS 스펙 출처 주석은 **그대로 둡니다.** 바뀌는 건 이 한계를 대하는 태도지 숫자가 아닙니다. 다만 주석에 "카카오는 스레드로 나누지 않는다"는 사실을 한 줄 더하세요.

`emitKakaoPaste`가 언제나 정확히 세그먼트 1개를 낸다는 것을 고정하는 테스트를 추가하세요 — 포스트 경계(`\n\n\n`)와 `---` 구분선이 든 입력을 줘도 1개인지. 지금은 우연히 맞는 상태고, 아무 테스트도 그걸 붙들고 있지 않습니다.

---

## Task 3: 변환 코퍼스

**주의: `conversion/*`는 gitignore입니다**(`.gitignore:13-15`). 실제 가이드는 커밋되지 않고 `pnpm config:push`로 팀 Drive에 나갑니다. `*.example.*`만 커밋됩니다.

만들 것:
- `conversion/kakao_notice.md` — 새 가이드. `announcement.md`에서 카카오 관련 문단(`:4`, `:97`, `:173`)을 가져와 여기 두고, **핵심 규칙**을 명시: 카카오는 한 통, CTA 포함 500자 이내, 마크업 없음(카카오는 아무 서식도 파싱하지 않음), 그리고 텔레그램 공지의 요약본이라는 성격. 400자 안팎을 목표로 쓰라고 하세요 — CTA 73자가 자동으로 붙습니다.
- `conversion/kakao_notice.example.md` — 커밋되는 골격. 다른 `*.example.md`의 형식을 그대로 따르세요.
- `conversion/few-shot.kakao_notice.example.json` — `[]`. 커밋됩니다.

고칠 것:
- `conversion/announcement.md:4,97,173` — 카카오에도 같은 원고가 나간다는 약속과 👉 아이콘 설명을 걷어냅니다. 이제 거짓입니다. 새 가이드를 가리키세요.

`pnpm doctor`가 `conversion/<type>.md` 부재를 잡습니다(`src/doctor/steering.ts:11-13`) — 가이드가 없으면 조용히 무보정 프롬프트로 변환되니, 이 태스크가 끝나야 doctor가 초록입니다. 마지막에 `pnpm doctor` 돌려 확인하세요.

---

## Task 4: 문서

`announcement`가 카카오를 나른다고 적은 곳과 "타입 6개"라고 센 곳을 고칩니다.

`docs/ko/review.md:96`(유형 표), `:208`(체크리스트 표) · `docs/ko/setup/steering.md:80-85,105`(파일 개수 목록) · `docs/ko/team-runbook.md:60,296,1301`("최대 6개") · `docs/ko/setup/channels.md:53-54` · `docs/ko/quickstart.md:139` · `docs/ko/artifacts.md:144,383-384` · `docs/ko/capabilities.md:189`.

행을 더하고 숫자를 고치는 수준입니다. 표를 재구성하지 마세요.

---

## 마무리

`pnpm test` · `pnpm typecheck` · `pnpm doctor` 셋 다 초록. 그다음 PR → 스쿼시 머지 → `pnpm deploy:check` → `npx vercel deploy --prod` → `pnpm deploy:smoke`. 코퍼스는 `pnpm config:push`로 따로 나갑니다.
