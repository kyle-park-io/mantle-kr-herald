# 한국 링크 치환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** x 번역문 안의 맨틀 글로벌 자기 글 링크를, 그 글의 한국 게시물 링크로 발송·미리보기 시점에 치환한다.

**Architecture:** 순수 함수 두 개(링크 추출 / 치환)를 새 모듈에 두고, 어제 CTA가 쓴 것과 같은 두 호출부(`SendChannels`의 emit 직전, `/emissions`의 emitAll 직전)가 부른다. URL 해석은 기존 `resolveXPostUrl`을 재사용하며 새 해석기는 만들지 않는다.

**참조 스펙:** `docs/superpowers/specs/2026-08-13-kr-link-rewrite-design.md`

## Global Constraints

- 치환 대상은 **`x` 타입만.** 다른 타입은 손대지 않는다.
- 치환 대상 링크는 **맨틀 글로벌 계정 것만.** 판별은 `isSweptAccount`(`src/domain/sweptAccount.ts:42`), 상수를 다시 쓰지 말 것.
- 한국 게시물이 없으면 **원문 링크를 그대로 둔다.** 발송을 막지 않는다.
- 저장된 `translations.korean_text`·`variants.converted_text`는 **수정하지 않는다.**
- 치환은 `emit` **앞**에서 일어나야 한다 — 길이 판정이 치환된 길이를 세야 한다.
- 검수 알림은 미해결 링크가 있을 때만 나온다. 전부 해결됐으면 아무 말도 하지 않는다.

---

### Task 1: 순수 함수

**Files:** `src/domain/formatting/krLinks.ts` (신규), `tests/domain/formatting/krLinks.test.ts` (신규)

**Produces** — Task 2·3이 이 이름을 쓴다:
- `needsKrLinkRewrite(type: string): boolean`
- `linkedSweptItemIds(text: string): string[]`
- `rewriteGlobalLinks(text: string, krUrlByItemId: ReadonlyMap<string, string>): { text: string; unresolved: number }`
- `krLinkNotice(unresolved: number): string | null`

두 단계로 나눈 이유를 주석에 남길 것: 링크 해석은 `/emissions`에서 비동기(`deps.loadXPostUrl`)이고 `SendChannels`에서는 동기다. 추출(순수)과 치환(순수) 사이에 호출부가 자기 방식으로 해석을 끼우면 양쪽 다 순수하게 유지된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { describe, expect, it } from "vitest";
import { needsKrLinkRewrite, linkedSweptItemIds, rewriteGlobalLinks, krLinkNotice } from "../../../src/domain/formatting/krLinks";

const G = (id: string) => `https://x.com/Mantle_Official/status/${id}`;
const KR = "https://x.com/0xMantleKR/status/2087418810458382585";

describe("needsKrLinkRewrite", () => {
  it("is true only for the x type", () => {
    expect(needsKrLinkRewrite("x")).toBe(true);
    for (const t of ["announcement", "kakao_notice", "explainer", "casual", "kol", "pr"]) {
      expect(needsKrLinkRewrite(t)).toBe(false);
    }
  });
});

describe("linkedSweptItemIds", () => {
  it("finds a Mantle Global post link", () => {
    expect(linkedSweptItemIds(`본문\n${G("111")}`)).toEqual(["x:111"]);
  });

  it("ignores a link to any other account", () => {
    expect(linkedSweptItemIds("https://x.com/xStocksFi/status/222")).toEqual([]);
  });

  it("ignores a link to our own Korean account", () => {
    expect(linkedSweptItemIds(KR)).toEqual([]);
  });

  it("ignores a non-status x.com url", () => {
    expect(linkedSweptItemIds("https://x.com/Mantle_Official")).toEqual([]);
  });

  it("dedupes and keeps first-seen order", () => {
    expect(linkedSweptItemIds(`${G("222")} ${G("111")} ${G("222")}`)).toEqual(["x:222", "x:111"]);
  });

  it("finds nothing in text with no links", () => {
    expect(linkedSweptItemIds("링크 없는 본문")).toEqual([]);
  });
});

describe("rewriteGlobalLinks", () => {
  it("swaps a resolved link and reports nothing unresolved", () => {
    const r = rewriteGlobalLinks(`앞 ${G("111")} 뒤`, new Map([["x:111", KR]]));
    expect(r.text).toBe(`앞 ${KR} 뒤`);
    expect(r.unresolved).toBe(0);
  });

  it("leaves an unresolved link alone and counts it", () => {
    const r = rewriteGlobalLinks(G("111"), new Map());
    expect(r.text).toBe(G("111"));
    expect(r.unresolved).toBe(1);
  });

  it("judges each link independently", () => {
    const r = rewriteGlobalLinks(`${G("111")}\n${G("222")}`, new Map([["x:111", KR]]));
    expect(r.text).toBe(`${KR}\n${G("222")}`);
    expect(r.unresolved).toBe(1);
  });

  it("counts one unresolved link once even when it appears twice", () => {
    const r = rewriteGlobalLinks(`${G("111")} ${G("111")}`, new Map());
    expect(r.unresolved).toBe(1);
  });

  it("never touches another account's link", () => {
    const other = "https://x.com/xStocksFi/status/222";
    expect(rewriteGlobalLinks(other, new Map([["x:222", KR]])).text).toBe(other);
  });

  it("leaves surrounding punctuation intact", () => {
    const r = rewriteGlobalLinks(`(${G("111")})`, new Map([["x:111", KR]]));
    expect(r.text).toBe(`(${KR})`);
  });
});

describe("krLinkNotice", () => {
  it("says nothing when everything resolved", () => {
    expect(krLinkNotice(0)).toBeNull();
  });

  it("names the count and the remedy when something did not", () => {
    const n = krLinkNotice(2)!;
    expect(n).toContain("2건");
    expect(n).toContain("한국 글");
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm test tests/domain/formatting/krLinks.test.ts`, 모듈 없음으로 FAIL.

- [ ] **Step 3: 구현**

`parsePostUrl`(`src/domain/publish/xReconcile.ts:183`)은 앵커된 정규식이라 문장 속 URL을 못 찾는다. 전역 정규식으로 후보를 뽑고 각 후보를 `parsePostUrl`로 검증하는 두 단계로 쓸 것 — URL의 정의를 두 번 쓰지 않기 위해서다.

```ts
import { parsePostUrl } from "../publish/xReconcile";
import { isSweptAccount } from "../sweptAccount";

/**
 * Candidate x.com status URLs in a body of text. Deliberately loose: every match is handed to
 * `parsePostUrl`, which owns what a post URL actually is. Matching here and validating there means
 * this file never carries a second definition of the same shape.
 */
const X_STATUS_URL = /https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+/g;

/** Only `x` copy is a near-verbatim translation, so only it carries the source's inline links. */
export function needsKrLinkRewrite(type: string): boolean {
  return type === "x";
}
```

`linkedSweptItemIds`는 매치를 순회하며 `parsePostUrl` → `isSweptAccount(handle)` → `x:<rootId>`, 중복 제거 후 첫 등장 순서 유지.

`rewriteGlobalLinks`는 `text.replace(X_STATUS_URL, ...)`로 각 매치를 판정한다. 스웹트 계정이 아니면 원문 반환. 맞으면 맵을 보고 있으면 한국 URL, 없으면 원문 반환하고 미해결 **아이템 id를 Set에 모은다** — 같은 링크가 두 번 나와도 1로 세기 위해서다.

`krLinkNotice`:
```ts
export function krLinkNotice(unresolved: number): string | null {
  return unresolved === 0
    ? null
    : `링크된 글로벌 글 ${unresolved}건은 아직 한국 글이 없습니다. 먼저 올리면 자동으로 한국 링크가 됩니다.`;
}
```

- [ ] **Step 4: 통과 확인** — `pnpm test tests/domain/formatting/krLinks.test.ts`
- [ ] **Step 5: `pnpm test && pnpm typecheck`**
- [ ] **Step 6: 커밋** — `feat(format): rewrite a Mantle Global link to its Korean post`

---

### Task 2: 미리보기에 물린다

**Files:** `src/adapters/web/apiHandlers.ts`, `tests/adapters/web/apiHandlers.test.ts`

**Consumes:** Task 1 전부. `deps.loadXPostUrl(itemId)`는 이미 `ApiDeps`에 있다(어제 추가) — 그대로 링크 대상 해석에 쓴다. **새 deps 필드를 만들지 말 것.**

`/emissions` 두 라우트 모두. 어제 만든 `withXLinkCta` 헬퍼 바로 옆에 같은 모양의 단계를 둔다:

1. `needsKrLinkRewrite(type)` 아니면 그대로 통과.
2. `linkedSweptItemIds(text)` → 각 id마다 `await deps.loadXPostUrl(id)` → 있는 것만 맵에 담는다.
3. `rewriteGlobalLinks(text, map)` → 치환된 텍스트와 `unresolved`.
4. `emitAll(치환된 텍스트, ...)`.
5. `krLinkNotice(unresolved)`가 null이 아니면 **모든 destination의 `warnings` 앞에 붙인다.**

5번이 화면에 뜨는 경로다 — `OutletCard.tsx:207,411`이 destination별 `warnings`를 렌더링하며, 카카오 접힘 경고가 이미 그 통로를 쓴다.

**테스트** (기존 `/emissions` 테스트의 `makeDeps`·`rnd` 방식 그대로):
- x 타입 + 해석되는 링크 → 응답에 한국 URL, 글로벌 URL 없음, 경고 없음
- x 타입 + 해석 안 되는 링크 → 글로벌 URL 그대로, 경고에 알림 문구
- announcement 타입 + 글로벌 링크 → 손대지 않음, 경고 없음
- 링크 여럿, 일부만 해석 → 해석된 것만 바뀌고 경고는 남은 개수를 말함

- [ ] **Step 1~6:** 실패 테스트 → 확인 → 구현 → 통과 → `pnpm test && pnpm typecheck` → 커밋

---

### Task 3: 발송 경로에 물린다

**Files:** `src/app/SendChannels.ts`, `tests/app/sendChannels.test.ts`

**Consumes:** Task 1 전부.

`SendChannels.run`은 이미 `sourceByItem`(모든 번역)과 `ledgered`(모든 배송)를 들고 있다. 어제 CTA를 붙인 그 자리에서 같은 데이터로 링크 대상도 해석한다.

`for (const r of candidates)` 루프 안, CTA 블록 근처에:

```ts
      // Only `x` copy carries the source's inline links (see `needsKrLinkRewrite`).
      // Resolved per rendering from the data already loaded above — no extra store read.
      let krLinks: ReadonlyMap<string, string> | undefined;
      if (needsKrLinkRewrite(r.type)) {
        const map = new Map<string, string>();
        for (const id of linkedSweptItemIds(...)) {
          const url = resolveXPostUrl(sourceByItem.get(id), ledgered.filter((d) => d.itemId === id));
          if (url) map.set(id, url);
        }
        krLinks = map;
      }
```

주의 — 링크는 **방마다 다를 수 있는 텍스트**(포크)에서 뽑아야 하므로, 추출과 치환은 `byText` 루프 **안**에서 각 `text`에 대해 한다. 위 블록은 그 구조에 맞게 배치할 것. 치환은 CTA를 붙이기 **전후 어느 쪽이든 무방**하지만(CTA에는 글로벌 링크가 없다) 순서를 고정하고 주석으로 남길 것.

치환된 텍스트가 `emit`으로 가야 한다 — 길이 판정이 그것을 세야 한다. 아카이브(`this.archive`)도 방이 실제로 받은 것을 적어야 하므로 치환된 텍스트를 넘긴다.

미해결이 있으면 `console.warn`만 남긴다. **`SendChannelsResult.warnings`에는 넣지 말 것** — 그 필드는 "보내긴 했는데 요청대로 다 안 된 것"(핀 실패 등)이고, 글로벌 링크가 나간 것은 그 부류가 아니다. 검수자가 결정할 자리는 미리보기이지 발송 로그가 아니다.

**테스트:**
- x 렌더링 + 해석되는 링크 → sender가 받은 segments에 한국 URL
- 해석 안 되면 글로벌 URL 그대로, 그래도 발송됨(`sent: 1`)
- 치환이 길이 계산에 포함됨
- announcement는 손대지 않음
- 아카이브에 치환된 텍스트가 남음

**어제 배운 것:** 이 스위트의 `rendering()` 기본값은 `announcement`/`telegram`이라 x 픽스처는 명시해야 한다. 그리고 통과하는 테스트 중 의미가 조용히 바뀐 것이 없는지 확인할 것.

- [ ] **Step 1~6:** 실패 테스트 → 확인 → 구현 → 통과 → `pnpm test && pnpm typecheck` → 커밋

---

## 마무리

`pnpm test` · `pnpm typecheck` · `pnpm doctor` 셋 다 초록. PR → 스쿼시 머지 → `deploy:check` → `vercel deploy --prod` → `deploy:smoke`. 코퍼스 변경이 없으므로 `config:push`와 `herald-deploy.sh`는 이번엔 불필요하다.
