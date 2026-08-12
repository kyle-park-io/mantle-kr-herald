# 공지 X 링크 CTA + X 채널 아이콘 제거 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** X 채널 출력에서 링크 앞 아이콘을 떼고, 공지(announcement)가 텔레그램·카카오로 나갈 때 외부 링크 CTA 대신 우리 X 게시물을 가리키는 CTA를 발송 시점에 붙인다.

**Architecture:** 렌더링은 X 게시물 URL이 생기기 전에 확정되므로(`ConvertTick.ts:16-20`) CTA는 저장하지 않고 발송/미리보기 시점에 조립한다. 조립 로직은 `src/domain/formatting/xLinkCta.ts` 순수 함수 한 벌에 두고, 봇 발송(`SendChannels`)과 [복사] 미리보기(`/emissions`) 두 호출부가 같은 함수를 부른다 — 카카오와 텔레그램 일부 방은 `delivery: "manual"`이라 봇 경로를 아예 타지 않기 때문이다.

**Tech Stack:** TypeScript (ESM, `type: module`), vitest, pnpm. 테스트는 `pnpm test`, 타입 체크는 `pnpm typecheck`.

## Global Constraints

- CTA 문구는 정확히 `자세한 내용은 X에서 확인하세요` — 토씨 하나 바꾸지 않는다.
- 아이콘: 텔레그램 `➡`, 카카오 `👉`. 그 외 채널은 CTA 없음.
- CTA 형태는 `<아이콘> <문구> (<URL>)` 리터럴. 마크다운 링크(`[라벨](url)`)로 만들지 않는다 — `emitTelegramBot`이 `MD_LINK`를 `<a href>`로 바꿔 URL을 감춘다(`src/domain/formatting/emitters/telegram.ts:44-46`).
- CTA는 `announcement` 타입에만 붙는다. 해설·캐주얼·KOL·PR·x 채널은 대상 아님.
- 유효한 X 게시물 URL은 `https://x.com/` 으로 시작하는 것만 인정한다 — `deliveries.url`은 리컨사일 전까지 Typefully share_url을 담고 있다(`src/app/SendChannels.ts:301` → `src/app/ReconcilePublished.ts:71-73`).
- 이미 저장된 렌더링의 옛 CTA는 코드가 건드리지 않는다. 스펙 "이미 저장된 렌더링은 안 고친다" 참조.
- 기존 주석 밀도와 한국어/영어 혼용 스타일을 따른다. 이 저장소는 "왜"를 주석에 길게 적는다.

**참조 스펙:** `docs/superpowers/specs/2026-08-12-announcement-x-link-cta-design.md`

---

## File Structure

| 파일 | 책임 | 상태 |
|---|---|---|
| `src/domain/formatting/emitters/x.ts` | X 채널 emit + 링크 아이콘 제거 | 수정 |
| `src/domain/formatting/xLinkCta.ts` | CTA 조립 + X URL 선택 (순수) | **신규** |
| `src/app/SendChannels.ts` | 봇 발송 경로에서 CTA 부착 / URL 없으면 차단 | 수정 |
| `src/adapters/web/apiHandlers.ts` | `/emissions` 미리보기에 CTA 반영 | 수정 |
| `src/app/createDeps.ts` | `loadXPostUrl` 조립 | 수정 |
| `conversion/x.md`, `conversion/announcement.md`, `conversion/few-shot.announcement.json` | 에이전트가 외부 링크 CTA를 못 쓰게 | 수정 |

---

### Task 1: X 채널 링크 아이콘 제거

**Files:**
- Modify: `src/domain/formatting/emitters/x.ts`
- Test: `tests/domain/formatting/emitters/x.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `stripLinkIcon(text: string): string` — `emitters/x.ts`에서 export. Task 2~5는 쓰지 않는다.

- [ ] **Step 1: Write the failing tests**

`tests/domain/formatting/emitters/x.test.ts` 끝에 추가한다. 파일 상단 import에 `stripLinkIcon`을 더한다(기존 import 줄에 이어붙일 것).

```ts
import { emitXPaste, emitXTypefully, stripLinkIcon } from "../../../../src/domain/formatting/emitters/x";

describe("stripLinkIcon", () => {
  it("strips an icon from a line that is only an icon and a url", () => {
    expect(stripLinkIcon("🔗 https://fluxion.network/trade")).toBe("https://fluxion.network/trade");
  });

  it("leaves a bracketed media marker alone", () => {
    const line = "[영상] https://video.twimg.com/amplify_video/1/vid.mp4";
    expect(stripLinkIcon(line)).toBe(line);
  });

  it("leaves a url that follows words on the same line alone", () => {
    const line = "· 거래: https://fluxion.network/trade";
    expect(stripLinkIcon(line)).toBe(line);
  });

  it("leaves a url inside a sentence alone", () => {
    const line = "자세한 내용은 https://fluxion.network/trade 에서 확인하세요.";
    expect(stripLinkIcon(line)).toBe(line);
  });

  it("strips on every line of a multi-line text", () => {
    expect(stripLinkIcon("본문\n\n🔗 https://a.example\n▶ https://b.example")).toBe(
      "본문\n\nhttps://a.example\nhttps://b.example",
    );
  });

  it("leaves a bare url with no icon untouched", () => {
    expect(stripLinkIcon("https://fluxion.network/trade")).toBe("https://fluxion.network/trade");
  });
});

describe("emitXPaste link icons", () => {
  it("drops the icon before a trailing bare url", () => {
    const { segments } = emitXPaste("자세한 내용은 아래에서 확인하세요.\n🔗 https://fluxion.network/trade");
    expect(segments[0].text).toBe("자세한 내용은 아래에서 확인하세요.\nhttps://fluxion.network/trade");
  });

  it("applies to the typefully destination too", () => {
    const { segments } = emitXTypefully("🔗 https://fluxion.network/trade");
    expect(segments[0].text).toBe("https://fluxion.network/trade");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/domain/formatting/emitters/x.test.ts`
Expected: FAIL — `stripLinkIcon is not a function` (또는 import 해석 실패).

- [ ] **Step 3: Implement**

`src/domain/formatting/emitters/x.ts`의 import 아래, `emitX` 위에 추가한다.

```ts
/**
 * A line that is nothing but a symbol and a bare URL. `\p{L}`/`\p{N}` are excluded from the symbol
 * class on purpose: that is what makes `[영상] https://…` (media marker) and `· 거래: https://…`
 * (a labelled bullet) fall out — both open with a symbol, but a letter follows before the URL does.
 * The lookahead pins the URL to end-of-line, so a URL sitting inside a sentence is never touched.
 */
const ICON_BEFORE_BARE_URL = /^[^\p{L}\p{N}\s]+[ \t]+(?=https?:\/\/\S+[ \t]*$)/gmu;

/**
 * Drop an icon written in front of a bare URL — `conversion/x.md:59-66` forbids it ("링크 앞에
 * 아이콘을 붙이지 않고 URL을 그대로 씁니다"), and the conversion agent wrote one anyway, so the rule
 * gets a guard here rather than a louder wording in the guide.
 *
 * X only. Telegram and KakaoTalk keep their emoji style, and their 공지 CTA opens with one by design
 * (see `src/domain/formatting/xLinkCta.ts`).
 *
 * Exported for its own tests; `emitX` below is the only production caller.
 */
export function stripLinkIcon(text: string): string {
  return text.replace(ICON_BEFORE_BARE_URL, "");
}
```

그리고 `emitX` 본문 첫 줄(현재 `x.ts:14`)을 바꾼다.

```ts
  const posts = splitPosts(stripLinkIcon(canonical));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/domain/formatting/emitters/x.test.ts`
Expected: PASS — 새 테스트와 기존 테스트 전부.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 둘 다 통과. 실패하면 고치고 다시 돌린다.

- [ ] **Step 6: Commit**

```bash
git add src/domain/formatting/emitters/x.ts tests/domain/formatting/emitters/x.test.ts
git commit -m "fix(x): drop the icon written in front of a bare url"
```

---

### Task 2: CTA 조립과 X URL 선택 (순수 함수)

**Files:**
- Create: `src/domain/formatting/xLinkCta.ts`
- Test: `tests/domain/formatting/xLinkCta.test.ts` (신규)

**Interfaces:**
- Consumes: `Channel` (`src/domain/formatting/models.ts:3`), `DeliveryEntry`·`deliveredToRoom` (`src/domain/delivery/models.ts:29, :53`)
- Produces — Task 3·4가 이 이름들을 그대로 쓴다:
  - `needsXLinkCta(type: string, channel: Channel): boolean`
  - `xLinkCta(channel: Channel, xUrl: string): string`
  - `appendXLinkCta(text: string, cta: string): string`
  - `resolveXPostUrl(translation: { postedUrl?: string } | undefined, deliveries: DeliveryEntry[]): string | undefined`
  - `X_URL_PENDING: string`

- [ ] **Step 1: Write the failing tests**

`tests/domain/formatting/xLinkCta.test.ts` 를 만든다.

```ts
import { describe, expect, it } from "vitest";
import {
  needsXLinkCta,
  xLinkCta,
  appendXLinkCta,
  resolveXPostUrl,
  X_URL_PENDING,
} from "../../../src/domain/formatting/xLinkCta";
import type { DeliveryEntry } from "../../../src/domain/delivery/models";

const URL = "https://x.com/0xMantleKR/status/2087418810458382585";

function delivery(over: Partial<DeliveryEntry> = {}): DeliveryEntry {
  return { itemId: "x:1", type: "x", outletId: "x-post", status: "sent", at: "2026-08-12T00:00:00.000Z", by: "auto", ...over };
}

describe("needsXLinkCta", () => {
  it("is true for an announcement on telegram and kakao", () => {
    expect(needsXLinkCta("announcement", "telegram")).toBe(true);
    expect(needsXLinkCta("announcement", "kakao")).toBe(true);
  });

  it("is false for every other type on those channels", () => {
    for (const type of ["explainer", "casual", "kol", "pr", "x"]) {
      expect(needsXLinkCta(type, "telegram")).toBe(false);
    }
  });

  it("is false for an announcement on x and pr_mail", () => {
    expect(needsXLinkCta("announcement", "x")).toBe(false);
    expect(needsXLinkCta("announcement", "pr_mail")).toBe(false);
  });
});

describe("xLinkCta", () => {
  it("uses ➡ on telegram", () => {
    expect(xLinkCta("telegram", URL)).toBe(`➡ 자세한 내용은 X에서 확인하세요 (${URL})`);
  });

  it("uses 👉 on kakao", () => {
    expect(xLinkCta("kakao", URL)).toBe(`👉 자세한 내용은 X에서 확인하세요 (${URL})`);
  });

  it("is not a markdown link — the url has to stay visible after emit", () => {
    expect(xLinkCta("telegram", URL)).not.toContain("](");
  });
});

describe("appendXLinkCta", () => {
  it("separates the cta from the body with one blank line", () => {
    expect(appendXLinkCta("본문", "➡ cta")).toBe("본문\n\n➡ cta");
  });
});

describe("resolveXPostUrl", () => {
  it("prefers the translation's posted url", () => {
    expect(resolveXPostUrl({ postedUrl: URL }, [])).toBe(URL);
  });

  it("falls back to the x-post delivery row", () => {
    expect(resolveXPostUrl(undefined, [delivery({ url: URL })])).toBe(URL);
  });

  it("ignores a typefully share url on the delivery row", () => {
    expect(resolveXPostUrl(undefined, [delivery({ url: "https://typefully.com/t/abc123" })])).toBeUndefined();
  });

  it("ignores a typefully share url on the translation and falls through", () => {
    expect(resolveXPostUrl({ postedUrl: "https://typefully.com/t/abc" }, [delivery({ url: URL })])).toBe(URL);
  });

  it("ignores a dropped delivery row", () => {
    expect(resolveXPostUrl(undefined, [delivery({ url: URL, status: "dropped" })])).toBeUndefined();
  });

  it("ignores a delivery row for another room", () => {
    expect(resolveXPostUrl(undefined, [delivery({ url: URL, outletId: "tg-community" })])).toBeUndefined();
  });

  it("is undefined when nothing carries a url", () => {
    expect(resolveXPostUrl(undefined, [])).toBeUndefined();
    expect(resolveXPostUrl({}, [delivery()])).toBeUndefined();
  });
});

describe("X_URL_PENDING", () => {
  it("is not a url, so a preview cannot be pasted as one", () => {
    expect(X_URL_PENDING).not.toContain("http");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/domain/formatting/xLinkCta.test.ts`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: Implement**

`src/domain/formatting/xLinkCta.ts` 를 만든다.

```ts
import type { Channel } from "./models";
import type { DeliveryEntry } from "../delivery/models";
import { deliveredToRoom } from "../delivery/models";

/**
 * The 공지 CTA, composed at send time rather than stored on the rendering.
 *
 * It cannot be stored: a rendering is written by `FormatVariants` before the X post it points at
 * exists (`ConvertTick.ts:16-20` stops at `rendered`), and re-rendering after publication is
 * refused outright (`FormatVariants.ts:120-121`). So the URL is late-bound by definition.
 *
 * Both the bot path (`SendChannels`) and the [복사] preview (`/emissions`) call these. That is not
 * an accident of two call sites: every KakaoTalk room and two of the Telegram rooms are
 * `delivery: "manual"` (`src/domain/outlet/models.ts:42-46`), so a human pastes what the board
 * shows. If the two paths composed the CTA separately they would eventually disagree, and the copy
 * a room receives would depend on who sent it.
 */

/** Per-channel CTA icon. A channel absent from this map gets no CTA at all. */
const CTA_ICON: Partial<Record<Channel, string>> = {
  telegram: "➡",
  kakao: "👉",
};

const CTA_LABEL = "자세한 내용은 X에서 확인하세요";

/** Only the KR account's own post counts. See `resolveXPostUrl`. */
const X_POST_PREFIX = "https://x.com/";

/** The room the KR X post is delivered to (`src/domain/outlet/models.ts:36`). */
const X_POST_OUTLET = "x-post";

/**
 * Stand-in shown in the [복사] preview before the X post exists. Deliberately not a URL: a preview
 * is copy-pasteable, and a plausible-looking placeholder would eventually reach a live room.
 */
export const X_URL_PENDING = "X 게시 후 채워짐";

/** 공지 only, and only on the two channels that carry it. */
export function needsXLinkCta(type: string, channel: Channel): boolean {
  return type === "announcement" && CTA_ICON[channel] !== undefined;
}

/**
 * Never a markdown link. `emitTelegramBot` rewrites `[label](url)` into `<a href>`
 * (`emitters/telegram.ts:44-46`), which would hide the URL — and the URL showing is the point.
 * `label (url)` carries no `[`, so `MD_LINK` cannot match it and every emitter passes it through.
 */
export function xLinkCta(channel: Channel, xUrl: string): string {
  return `${CTA_ICON[channel]} ${CTA_LABEL} (${xUrl})`;
}

/** One blank line, i.e. a canonical paragraph break — never three, which is an x post boundary. */
export function appendXLinkCta(text: string, cta: string): string {
  return `${text}\n\n${cta}`;
}

function isXPostUrl(url: string | undefined): url is string {
  return url !== undefined && url.startsWith(X_POST_PREFIX);
}

/**
 * The KR X post URL for one item, or undefined if it has not gone up yet.
 *
 * Two sources, because there are two ways the post gets made. A hand-posted one is reconciled onto
 * the translation (`RetireTranslation.ts:136`, via `pnpm x:reconcile` or `pnpm x:link`); a bot-sent
 * one lands on the `x-post` delivery row (`ReconcilePublished.ts:71-73`).
 *
 * The `https://x.com/` check is not decoration. `SendChannels` writes the Typefully *share* url onto
 * that delivery row at send time (`SendChannels.ts:301`) and it only becomes an x.com url minutes
 * later, when the draft actually publishes. Without this check a 공지 would carry a link to our own
 * draft editor.
 */
export function resolveXPostUrl(
  translation: { postedUrl?: string } | undefined,
  deliveries: DeliveryEntry[],
): string | undefined {
  // Bound to a local first: a type guard on `translation?.postedUrl` narrows that expression, not
  // `translation`, so reading it back off the object would still be `possibly undefined` to tsc.
  const posted = translation?.postedUrl;
  if (isXPostUrl(posted)) return posted;
  const row = deliveries.find((d) => d.outletId === X_POST_OUTLET && deliveredToRoom(d) && isXPostUrl(d.url));
  return row?.url;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/domain/formatting/xLinkCta.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: 통과.

- [ ] **Step 6: Commit**

```bash
git add src/domain/formatting/xLinkCta.ts tests/domain/formatting/xLinkCta.test.ts
git commit -m "feat(format): compose the 공지 X-link CTA and resolve its late-bound url"
```

---

### Task 3: 봇 발송 경로에 CTA 부착

**Files:**
- Modify: `src/app/SendChannels.ts`
- Test: `tests/app/sendChannels.test.ts`

**Interfaces:**
- Consumes: Task 2의 `needsXLinkCta`, `xLinkCta`, `appendXLinkCta`, `resolveXPostUrl`
- Produces: 없음 (동작 변경만)

이 경로가 다루는 건 **텔레그램 공지뿐**이다. `isSendable`(`SendChannels.ts:89-91`)이 telegram과 x만 통과시키고, 카카오는 Task 4의 미리보기 경로로만 나간다.

- [ ] **Step 1: Write the failing tests**

`tests/app/sendChannels.test.ts` 에 추가한다. 기존 헬퍼를 그대로 쓴다 — `rendering()` (`:20`, 기본값이 이미 `type: "announcement", channel: "telegram"`), `source()` (`:31`), `fakeTranslations()` (`:35`), `fakeStore()` (`:43`), `fakeLedger()` (`:46`), `okSender()` (`:67`). 새 헬퍼를 만들지 말 것.

**`rendering()`의 기본 타입이 `announcement`/`telegram`이므로, 이 스위트의 기존 테스트 상당수가 이제 CTA를 받게 된다.** 기본 픽스처에 URL이 없으면 전부 `failed`로 떨어진다. Step 4에서 대량으로 깨질 것이고, 그게 정상이다 — 고치는 방법은 아래 Step 4에 있다.

sender가 받은 것을 보려면 `okSender`가 아니라 인자를 잡아두는 더블이 필요하다. 이 스위트에 이미 그런 패턴이 있으면 그것을 쓰고, 없으면 아래를 테스트 지역에 둔다.

```ts
const X_URL = "https://x.com/0xMantleKR/status/2087418810458382585";

/** Captures what each send actually carried. */
function capturingSender(name: "telegram" | "x") {
  const calls: { segments: string[] }[] = [];
  const sender: ChannelSender = {
    name,
    send: async (req) => {
      calls.push({ segments: req.segments });
      return { postId: "p", url: "u" };
    },
  };
  return { sender, calls };
}

describe("공지 X-link CTA", () => {
  it("appends the CTA to a telegram 공지, using the translation's posted url", async () => {
    const { sender, calls } = capturingSender("telegram");
    const sut = new SendChannels(
      fakeStore([rendering({})]),
      { telegram: sender, x: undefined },
      fakeLedger().ledger,
      fakeTranslations([source("x:1", { postedUrl: X_URL })]),
    );
    await sut.run({ targets: ["telegram"] });
    expect(calls[0].segments.join("\n")).toContain(`➡ 자세한 내용은 X에서 확인하세요 (${X_URL})`);
  });

  it("does not append a CTA to a telegram 해설", async () => {
    const { sender, calls } = capturingSender("telegram");
    const sut = new SendChannels(
      fakeStore([rendering({ type: "explainer" })]),
      { telegram: sender, x: undefined },
      fakeLedger().ledger,
      fakeTranslations([source("x:1", { postedUrl: X_URL })]),
    );
    await sut.run({ targets: ["telegram"] });
    expect(calls[0].segments.join("\n")).not.toContain("자세한 내용은 X에서 확인하세요");
  });

  it("does not append a CTA on the x channel", async () => {
    const { sender, calls } = capturingSender("x");
    const sut = new SendChannels(
      fakeStore([rendering({ type: "x", channel: "x" })]),
      { telegram: undefined, x: sender },
      fakeLedger().ledger,
      fakeTranslations([source("x:1", { postedUrl: X_URL })]),
    );
    await sut.run({ targets: ["x"] });
    expect(calls[0].segments.join("\n")).not.toContain("자세한 내용은 X에서 확인하세요");
  });

  it("refuses to send a 공지 with no X post url, and does not call the sender", async () => {
    const { sender, calls } = capturingSender("telegram");
    const sut = new SendChannels(
      fakeStore([rendering({})]),
      { telegram: sender, x: undefined },
      fakeLedger().ledger,
      fakeTranslations([source("x:1")]),
    );
    const res = await sut.run({ targets: ["telegram"] });
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.failures[0].error).toContain("X 게시물 URL");
    expect(calls).toHaveLength(0);
  });

  it("takes the url from the x-post delivery row when the translation has none", async () => {
    const { sender, calls } = capturingSender("telegram");
    const sut = new SendChannels(
      fakeStore([rendering({})]),
      { telegram: sender, x: undefined },
      fakeLedger([{ itemId: "x:1", type: "x", outletId: "x-post", status: "sent", at: "T", by: "auto", url: X_URL }]).ledger,
      fakeTranslations([source("x:1")]),
    );
    await sut.run({ targets: ["telegram"] });
    expect(calls[0].segments.join("\n")).toContain(X_URL);
  });

  it("does not accept a typefully share url as the X post url", async () => {
    const { sender } = capturingSender("telegram");
    const sut = new SendChannels(
      fakeStore([rendering({})]),
      { telegram: sender, x: undefined },
      fakeLedger([{ itemId: "x:1", type: "x", outletId: "x-post", status: "sent", at: "T", by: "auto", url: "https://typefully.com/t/abc" }]).ledger,
      fakeTranslations([source("x:1")]),
    );
    const res = await sut.run({ targets: ["telegram"] });
    expect(res.failed).toBe(1);
  });

  it("counts the CTA toward the telegram length limit", async () => {
    const { sender } = capturingSender("telegram");
    // The CTA is what pushes this over 4096 — the body alone fits.
    const cta = `➡ 자세한 내용은 X에서 확인하세요 (${X_URL})`;
    const body = "가".repeat(4096 - cta.length);
    const sut = new SendChannels(
      fakeStore([rendering({ text: body })]),
      { telegram: sender, x: undefined },
      fakeLedger().ledger,
      fakeTranslations([source("x:1", { postedUrl: X_URL })]),
    );
    const res = await sut.run({ targets: ["telegram"] });
    expect(res.failed).toBe(1);
    expect(res.failures[0].error).toContain("limit");
  });

  it("archives the text the room actually received, CTA included", async () => {
    const archived: { text: string }[] = [];
    const sut = new SendChannels(
      fakeStore([rendering({})]),
      { telegram: okSender("telegram"), x: undefined },
      fakeLedger().ledger,
      fakeTranslations([source("x:1", { postedUrl: X_URL })]),
      undefined,
      async (e) => { archived.push({ text: e.text }); },
    );
    await sut.run({ targets: ["telegram"] });
    expect(archived[0].text).toContain("자세한 내용은 X에서 확인하세요");
  });
});
```

**생성자 인자 순서를 반드시 `SendChannels.ts:94-130`에서 확인하고 맞출 것** — 위 코드의 `record`/`archive` 위치는 그 순서를 따른 것이다. 이 스위트의 기존 테스트가 sut를 어떻게 만드는지 베끼는 편이 안전하다.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/app/sendChannels.test.ts`
Expected: FAIL — CTA가 안 붙고, URL 없는 건도 그냥 발송된다.

- [ ] **Step 3: Implement**

import에 추가한다.

```ts
import { needsXLinkCta, xLinkCta, appendXLinkCta, resolveXPostUrl } from "../domain/formatting/xLinkCta";
```

`for (const r of candidates) {` 루프 안, `if (pending.length === 0) continue;` (현재 `:215`) **바로 아래**에 넣는다.

```ts
      // 공지 points readers back at our own X post, and that URL does not exist when the rendering
      // is written (see `xLinkCta.ts`). Resolved per rendering, before the per-text loop below, so
      // one missing URL fails the item once rather than once per room.
      let cta: string | undefined;
      if (needsXLinkCta(r.type, r.channel)) {
        const xUrl = resolveXPostUrl(
          sourceByItem.get(r.itemId),
          ledgered.filter((d) => d.itemId === r.itemId),
        );
        if (!xUrl) {
          // Not a warning-and-send: a 공지 whose whole job is to route readers to the X post, sent
          // without the link, is a live post nobody can recall and nobody would notice was wrong.
          // Failing keeps it retryable — a failed send is never ledgered, so the next run picks it
          // up as soon as the post is up and `x:reconcile` has run.
          const reason = "X 게시물 URL이 없습니다 — X를 먼저 게시하세요";
          console.warn(`[send] ${r.itemId}:${r.type} skipped for ${pending.map((o) => o.id).join(", ")}: ${reason}`);
          failures.push({ key: `${r.itemId}:${r.type}`, error: reason });
          failed += 1;
          continue;
        }
        cta = xLinkCta(r.channel, xUrl);
      }
```

그다음 `for (const [text, rooms] of byText) {` 루프 첫 줄에서 emit 대상만 바꾼다. 현재 `:229`:

```ts
      for (const [text, rooms] of byText) {
        // The CTA rides through `emit` rather than being appended after it, so the over-limit check
        // below weighs it. Appended after, a 공지 sitting just under 4096 would go out at 4096+N and
        // Telegram would 400 it forever.
        const sendText = cta ? appendXLinkCta(text, cta) : text;
        const emitResult = emit(sendText, DELIVERY_DESTINATION[r.channel], this.xMaxWeighted);
```

`extractMedia(text)` (현재 `:243`)는 **그대로 둔다** — 미디어 마커는 본문에만 있고 CTA에는 없다.

아카이브는 방이 실제로 받은 것을 적어야 하므로 `text` → `sendText`로 바꾼다. 현재 `:322`:

```ts
                await this.archive({ itemId: r.itemId, type: r.type, channel: r.channel, outletId: outlet.id, text: sendText, postId: res.postId, url: res.url, sentAt });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/app/sendChannels.test.ts`
Expected: 새 테스트는 PASS. **기존 테스트는 여럿 깨진다 — 예상된 일이다.**

`rendering()`의 기본값이 `type: "announcement", channel: "telegram"`이고 `source()`는 `postedUrl`을 안 주므로, 이 스위트의 공지 픽스처는 이제 "URL 없음 → 발송 차단"에 걸린다. 깨지는 테스트마다 무엇을 검증하려던 것인지 보고 둘 중 하나를 고른다.

- **CTA와 무관한 테스트** (아울렛 팬아웃, 원장 기록, 포크, 쿼터, 핀 등) → 그 테스트의 `fakeTranslations([...])`에 `postedUrl: X_URL`을 넣어 CTA가 정상적으로 붙게 한다. 이게 대부분의 경우다.
- **텍스트를 정확히 비교하는 테스트** → 기대값에 CTA를 더하거나, 픽스처 타입을 `explainer`로 바꿔 CTA 대상에서 빼라. 무엇을 검증하려는 테스트인지에 따라 고른다. 미디어 마커 테스트(`:263-269`, `:896-915`)는 후자가 맞다 — CTA와 상관없는 검증이다.

`X_URL` 상수를 파일 상단(픽스처 근처)으로 올려 모든 테스트가 쓰게 하라.

전부 통과할 때까지 반복한 뒤 다음 단계로 간다.

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 통과.

- [ ] **Step 6: Commit**

```bash
git add src/app/SendChannels.ts tests/app/sendChannels.test.ts
git commit -m "feat(send): carry the X-link CTA on 공지, and refuse to send without it"
```

---

### Task 4: [복사] 미리보기에 CTA 반영

**Files:**
- Modify: `src/adapters/web/apiHandlers.ts` (`:589-608` 두 `/emissions` 라우트, `ApiDeps` 인터페이스)
- Modify: `src/app/createDeps.ts` (`loadXPostUrl` 조립)
- Test: `tests/adapters/web/apiHandlers.test.ts`, `tests/support/fakeApiDeps.ts`

**Interfaces:**
- Consumes: Task 2 전부
- Produces: `ApiDeps.loadXPostUrl: (itemId: string) => Promise<string | undefined>`

카카오는 이 경로로만 나간다. 여기서 CTA가 빠지면 카카오 공지에는 영영 CTA가 안 붙는다.

- [ ] **Step 1: Write the failing tests**

`tests/adapters/web/apiHandlers.test.ts` 에 추가한다. 기존 `/emissions` 테스트(`:516-580`)의 구성 방식을 그대로 따를 것.

라우트 경로는 기존 테스트(`:518`)가 쓰는 형태 그대로다: `/api/renderings/x%3A1/announcement/telegram/emissions` (itemId는 URL 인코딩). 픽스처 헬퍼는 `rnd()`(`:22`)와 `makeDeps()`(`:45`).

```ts
const X_URL = "https://x.com/0xMantleKR/status/2087418810458382585";

describe("공지 X-link CTA in emissions", () => {
  it("uses 👉 for a kakao 공지", async () => {
    const deps = makeDeps([], [rnd({ channel: "kakao", type: "announcement", text: "본문" })]);
    deps.loadXPostUrl = async () => X_URL;
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/kakao/emissions", undefined);
    expect(JSON.stringify(res.json)).toContain(`👉 자세한 내용은 X에서 확인하세요 (${X_URL})`);
  });

  it("uses ➡ for a telegram 공지", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "announcement", text: "본문" })]);
    deps.loadXPostUrl = async () => X_URL;
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions", undefined);
    expect(JSON.stringify(res.json)).toContain(`➡ 자세한 내용은 X에서 확인하세요 (${X_URL})`);
  });

  it("shows a placeholder when the X post is not up yet", async () => {
    const deps = makeDeps([], [rnd({ channel: "kakao", type: "announcement", text: "본문" })]);
    deps.loadXPostUrl = async () => undefined;
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/kakao/emissions", undefined);
    expect(JSON.stringify(res.json)).toContain("X 게시 후 채워짐");
  });

  it("does not add a CTA to a 해설", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "explainer", text: "본문" })]);
    deps.loadXPostUrl = async () => X_URL;
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/explainer/telegram/emissions", undefined);
    expect(JSON.stringify(res.json)).not.toContain("자세한 내용은 X에서 확인하세요");
  });
});
```

**기존 `/emissions` 테스트 네 개(`:516-545`)가 깨진다.** 전부 `rnd({ channel: "telegram", type: "announcement" })` 픽스처를 쓰고, 정확한 문자열을 기대한다 — 예를 들어 `:527`은 `json.telegram_paste.segments[0].text`가 정확히 `"중요"`이길 기대하는데 이제 CTA가 뒤에 붙는다. 이 테스트들이 검증하려는 건 CTA가 아니라 **destination별 철자**이므로, 픽스처의 `type`을 `"explainer"`로 바꿔 CTA 대상에서 빼는 것이 맞다. `:546` 이후의 방별(`:outletId`) 테스트도 `boardWithFork()`가 `type: "announcement"`이므로 같은 판단을 적용하라.

`tests/support/fakeApiDeps.ts`의 `fakeDeps()`(`:73`)와 `fakeRenderingDeps()`(`:34`)에 `loadXPostUrl: async () => undefined` 를 더한다 — 안 그러면 타입이 안 맞는다.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/adapters/web/apiHandlers.test.ts`
Expected: FAIL — CTA가 없다.

- [ ] **Step 3: Implement**

`apiHandlers.ts` import에 추가한다.

```ts
import { needsXLinkCta, xLinkCta, appendXLinkCta, X_URL_PENDING } from "../../domain/formatting/xLinkCta";
```

`ApiDeps`에 필드를 더한다 (`loadTranslations` 근처, `:154` 부근).

```ts
  /**
   * The KR X post url for an item, or undefined before it goes up. Read only by the `/emissions`
   * routes, which is where a human copies 공지 text for a `delivery: "manual"` room — every
   * KakaoTalk room and two Telegram rooms. See `src/domain/formatting/xLinkCta.ts`.
   */
  loadXPostUrl: (itemId: string) => Promise<string | undefined>;
```

두 `/emissions` 라우트에서 `emitAll` 호출 앞에 CTA를 붙인다. 6-세그먼트 쪽(`:589-595`):

```ts
      if (method === "GET" && segments.length === 6 && segments[5] === "emissions") {
        const existing = (await deps.formattingStore.loadAll()).find(
          (r) => r.itemId === itemId && r.type === type && r.channel === channel,
        );
        if (!existing) return { status: 404, json: { error: "not found" } };
        const previewText = await withXLinkCta(deps, existing.itemId, existing.type, channel, existing.text);
        return { status: 200, json: emitAll(previewText, channel, deps.xMaxWeighted) };
      }
```

7-세그먼트(방별) 쪽(`:601-608`):

```ts
        if (!row) return { status: 404, json: { error: "not found" } };
        const previewText = await withXLinkCta(deps, itemId, type, channel, row.text);
        return { status: 200, json: emitAll(previewText, channel, deps.xMaxWeighted) };
```

그리고 `handleApi` 위, 파일의 다른 헬퍼들 곁에 헬퍼를 둔다.

```ts
/**
 * What the room will actually receive — the stored rendering plus the 공지 CTA the send path adds.
 *
 * The preview has to agree with `SendChannels` byte for byte: a reviewer approves what this returns,
 * and for a `delivery: "manual"` room this IS the send path — a human copies it. Both call the same
 * `xLinkCta`. Unlike the send path, a missing url is not fatal here: at preview time the X post
 * usually has not gone up yet, which is normal rather than an error, so the slot shows
 * `X_URL_PENDING` and the [복사] user learns the order they have to work in.
 */
async function withXLinkCta(
  deps: ApiDeps,
  itemId: string,
  type: string,
  channel: Channel,
  text: string,
): Promise<string> {
  if (!needsXLinkCta(type, channel)) return text;
  const xUrl = (await deps.loadXPostUrl(itemId)) ?? X_URL_PENDING;
  return appendXLinkCta(text, xLinkCta(channel, xUrl));
}
```

`Channel` 타입이 `apiHandlers.ts`에 아직 import 안 되어 있으면 더한다.

`src/app/createDeps.ts`에서 `loadXPostUrl`을 조립한다. `translationStore`(`:278`)와 `deliveryLedger`(`:285`)가 이미 그 스코프에 있다. 반환 객체에 더한다.

```ts
    loadXPostUrl: async (itemId: string) => {
      const [translations, deliveries] = await Promise.all([translationStore.loadAll(), deliveryLedger.loadAll()]);
      return resolveXPostUrl(
        translations.find((t) => t.itemId === itemId),
        deliveries.filter((d) => d.itemId === itemId),
      );
    },
```

import도 더한다.

```ts
import { resolveXPostUrl } from "../domain/formatting/xLinkCta";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/adapters/web/apiHandlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 통과. `ApiDeps`에 필수 필드를 더했으므로 다른 테스트의 deps 더블이 깨질 수 있다 — 깨지는 곳마다 `loadXPostUrl: async () => undefined` 를 더한다.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/web/apiHandlers.ts src/app/createDeps.ts tests/adapters/web/apiHandlers.test.ts tests/support/fakeApiDeps.ts
git commit -m "feat(web): show the 공지 X-link CTA in the emission preview"
```

---

### Task 5: 변환 가이드와 few-shot

**Files:**
- Modify: `conversion/announcement.md` (`:165` 이모지 목록)
- Modify: `conversion/few-shot.announcement.json` (`:4`, `:9`, `:24` 세 타깃의 끝)
- Modify: `conversion/x.md` (`:59-66` 규칙 강화)

코드가 CTA를 붙이므로, 에이전트가 계속 외부 링크 CTA를 쓰면 공지 끝에 CTA가 두 개 붙는다.

- [ ] **Step 1: `conversion/announcement.md` 이모지 목록에서 링크를 뺀다**

`:165` 현재:

```
사용 예: 📢 발표 · 📅 일정 · 📍 장소 · 🏆 리워드 · 🔗 링크 · 🔴 라이브
```

바꾼다:

```
사용 예: 📢 발표 · 📅 일정 · 📍 장소 · 🏆 리워드 · 🔴 라이브
```

- [ ] **Step 2: `conversion/announcement.md` 에 링크 규칙을 추가한다**

§11(이모지) 바로 다음, §12(로컬라이징) 앞에 새 절을 넣는다. 번호는 주변에 맞춰 다시 매길 것.

```markdown
## 12. 링크

**공지 끝에 링크를 쓰지 않습니다.** 파트너 사이트나 외부 페이지로 보내는 마무리 문장과 URL을
직접 쓰지 마세요.

- ❌ `거래 방법과 세부 조건은 아래 링크에서 확인하세요.\n🔗 https://fluxion.network/trade`
- ❌ `전체 분석은 아래 리포트에서 확인하세요.\n🔗 https://x.com/nansen_ai/status/...`

공지의 마무리 링크는 **발송 시점에 코드가 붙입니다** — 맨틀 코리아 X 계정의 해당 게시물로
연결되며, 채널에 맞는 아이콘(텔레그램 `➡`, 카카오 `👉`)도 코드가 정합니다. 그 URL은 공지를 쓰는
시점에 아직 존재하지 않으므로, 자리를 비워 두는 것이 맞습니다.

본문 **안에서** 맥락상 꼭 필요한 링크(예: 등록 페이지)는 그대로 쓸 수 있습니다. 금지되는 것은
글 끝의 "자세한 내용은 여기서" 형태의 마무리 CTA입니다.
```

- [ ] **Step 3: few-shot 세 타깃의 끝 CTA를 제거한다**

`conversion/few-shot.announcement.json`은 한 줄에 하나씩 `"target"` 문자열이 들어 있는 JSON이다. **가이드보다 few-shot이 세다** — 이 세 예시가 지금 에이전트에게 `🔗 <url>` 패턴을 직접 가르치고 있다.

- `:4` — 끝의 `\n\n자세한 내용은 공식 페이지에서 확인하세요.\n🔗 https://t.co/qodoG3RH1t` 를 지운다.
- `:9` — 끝의 `\n\n거래 방법과 세부 조건은 아래 링크에서 확인하세요.\n🔗 http://fluxion.network/trade` 를 지운다.
- `:24` — 끝의 `\n\n전체 분석은 아래 리포트에서 확인하세요.\n🔗 https://x.com/nansen_ai/status/2080594345774961004` 를 지운다.

각 타깃은 그 앞 문단에서 끝나야 한다. JSON 문자열이므로 이스케이프(`\n`)를 깨뜨리지 말 것.

- [ ] **Step 4: JSON이 여전히 유효한지 확인한다**

Run: `node -e "JSON.parse(require('fs').readFileSync('conversion/few-shot.announcement.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: `conversion/x.md` 규칙을 강화한다**

`:59-66`의 규칙은 이미 맞다. 지켜지지 않았을 뿐이므로, 코드가 이제 강제한다는 사실을 덧붙인다. `- ✅ \`https://fluxion.network/trade\`` 줄 다음에 추가한다.

```markdown
이 규칙은 코드로도 강제됩니다 — 줄 전체가 "아이콘 + URL"이면 발송 시점에 아이콘이 제거됩니다
(`src/domain/formatting/emitters/x.ts`의 `stripLinkIcon`). 그래도 처음부터 쓰지 않는 것이 맞습니다:
검수 화면에는 쓴 그대로 보입니다.
```

- [ ] **Step 6: 전체 스위트**

Run: `pnpm test && pnpm typecheck`
Expected: 통과. `conversion/` 파일을 읽는 테스트가 있으면(프롬프트 조립 테스트) 스냅샷이 깨질 수 있다 — 깨지면 새 내용으로 갱신한다.

- [ ] **Step 7: Commit**

```bash
git add conversion/announcement.md conversion/few-shot.announcement.json conversion/x.md
git commit -m "docs(conversion): stop teaching the agent to end a 공지 with an external link"
```

---

## 검수자용 수동 확인

전부 끝난 뒤, 로컬 대시보드에서 실제로 눈으로 본다. 로컬 DB에는 Neon에서 가져온 공지 두 건이 들어 있다(`x:2085728188546855340`, `x:2087156149368082696`).

```bash
pnpm build:web && pnpm serve   # http://localhost:5757 → #renderings
```

1. 공지(telegram) 행의 [복사] → CTA가 `➡`로 붙고, X 게시물이 없으므로 `(X 게시 후 채워짐)`이 보인다.
2. 공지(kakao) 행의 [복사] → 같은 자리에 `👉`.
3. 해설(telegram) 행의 [복사] → CTA 없음.
4. x 행의 [복사] → 끝의 `🔗`가 사라지고 URL만 남는다.

**주의:** 이 두 건은 Neon 실데이터라 본문 끝에 옛 CTA(`🔗 https://fluxion.network/trade`)가 이미 들어 있다. 코드는 이걸 지우지 않는 것이 설계이므로(스펙 "이미 저장된 렌더링은 안 고친다"), 미리보기에는 옛 CTA와 새 CTA가 **둘 다** 보인다. 새 CTA만 보고 싶으면 2차 검수 화면에서 옛 두 줄을 지우고 저장한 뒤 다시 [복사]하라.

**발송 버튼은 누르지 말 것** — `.env`의 채널 토큰이 실제 방을 가리킨다.
