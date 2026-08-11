# 링크 수집 탭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드에 x.com 링크를 붙여넣으면 그 글이 `x_threads`에 들어가, 타임라인이 수집한 글과 구별 없이 기존 파이프라인을 타게 한다.

**Architecture:** 새 유스케이스 `CollectLinkedThread`(`SourceGateway` + `CollectionRepository` + `TranslationStore`)가 URL 하나를 스레드 한 행으로 바꾼다. `handleApi`에 라우트 둘을 붙이면 로컬·Vercel 양쪽에 동시에 산다. 워터마크와 런 원장을 안 건드려 경로 전체가 파일시스템을 만지지 않고, 그래서 서버리스에서 돈다. `TWITTERAPI_IO_KEY`가 없는 배포에서는 `sendToOutlet`과 같은 모양으로 dep을 빼고 `StatusView.intakeEnabled`로 화면에 이유를 알린다.

**Tech Stack:** TypeScript (ESM, `type: module`), zod, Postgres(`pg`), React 18 + Vite + Tailwind, Vitest + @testing-library/react.

**설계 문서:** `docs/superpowers/specs/2026-08-12-link-intake-design.md` — 판단의 근거는 거기 있다. 이 계획은 그 판단을 코드로 옮긴다.

## Global Constraints

- **워터마크(`output/x/state.json`)와 런 원장(`output/x/runs.json`)을 절대 건드리지 않는다.** 링크 수집 경로에서 파일시스템 접근은 0이어야 한다 — Vercel 함수의 FS는 읽기 전용이다.
- **새 라우트는 `src/adapters/web/apiHandlers.ts`의 `handleApi` 안에만 넣는다.** `HttpServer.ts`에 직접 다는 것은 금지(그렇게 하면 호스팅에서 사라진다 — `GET /api/publish/local/*`가 그 예이며 따라 하지 말 것).
- **capability 불리언은 한 번 계산해 둘 다에 쓴다** — `createDeps`에서 계산한 값 하나가 dep 존재 여부와 `StatusView.intakeEnabled`를 동시에 결정한다. 두 번 계산하면 버튼과 라우트가 어긋난다.
- **사용자에게 보이는 문구는 전부 한국어**, 아래 표의 문자열을 **글자 그대로** 쓴다.
- **작성자 필터를 넣지 않는다.** 어느 계정 글이든 통과해야 한다.
- 커밋 메시지는 conventional commits(영어), 본문은 왜를 설명한다. 브랜치는 `feat/link-intake-tab`(이미 존재).
- 테스트는 `pnpm test`(vitest, 루트 설정이 `web/tests`까지 수집), 타입은 `pnpm typecheck` + `pnpm typecheck:web`.

### 거절 문구 — 글자 그대로

| 상수 | 문구 |
|---|---|
| `INTAKE_BAD_URL` | `x.com/<계정>/status/<번호> 형태의 주소가 필요합니다` |
| `INTAKE_NOT_FOUND` | `그 글을 가져올 수 없습니다 — 삭제됐거나 비공개일 수 있습니다` |
| `INTAKE_REPLY` | `이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다` |
| `INTAKE_DISABLED` | `이 배포에는 TWITTERAPI_IO_KEY가 없어 링크 수집을 할 수 없습니다` |

`outcome`별 화면 문구(`IntakeView`가 소유):

| `outcome` | 문구 |
|---|---|
| `collected` | `수집됐습니다 — 다음 번역 틱에서 초안이 만들어집니다` |
| `already-pending` | `이미 들어와 있습니다 — 다음 번역 틱에서 처리됩니다` |
| `already-translated` | `이미 번역돼 1차 검수에 있습니다` |

---

### Task 1: `CollectLinkedThread` 유스케이스

순수 app 계층. 배선은 Task 3에서 한다.

**Files:**
- Create: `src/app/CollectLinkedThread.ts`
- Test: `tests/app/collectLinkedThread.test.ts`

**Interfaces:**
- Consumes: `SourceGateway`(`src/ports/SourceGateway.ts`), `CollectionRepository`(`src/ports/CollectionRepository.ts`), `TranslationStore`(`src/ports/TranslationStore.ts`), `Clock`/`systemClock`(`src/ports/Clock.ts`), `parsePostUrl`(`src/domain/publish/xReconcile.ts`), `assembleThreads`(`src/domain/threadAssembler.ts`), `isCommenterReply`(`src/adapters/content/XContentSource.ts`)
- Produces:
  ```ts
  export type IntakeOutcome = "collected" | "already-pending" | "already-translated";
  export interface IntakeResult { itemId: string; tweets: number; outcome: IntakeOutcome }
  export const INTAKE_BAD_URL: string;
  export const INTAKE_NOT_FOUND: string;
  export const INTAKE_REPLY: string;
  export class CollectLinkedThread {
    constructor(gateway: SourceGateway, repo: CollectionRepository, translationStore: TranslationStore, now?: Clock);
    run(url: string): Promise<IntakeResult>;
  }
  ```

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/app/collectLinkedThread.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CollectLinkedThread,
  INTAKE_BAD_URL,
  INTAKE_NOT_FOUND,
  INTAKE_REPLY,
} from "../../src/app/CollectLinkedThread";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { ArticleBlock, CollectedThread, SourceTweet } from "../../src/domain/models";

const tweet = (over: Partial<SourceTweet> = {}): SourceTweet => ({
  id: "100",
  conversationId: "100",
  text: "Mantle ships something",
  createdAt: "2026-08-12T00:00:00.000Z",
  url: "https://x.com/Mantle_Official/status/100",
  authorUserName: "Mantle_Official",
  isReply: false,
  isQuote: false,
  ...over,
});

/** A gateway whose every method is a controllable stub. Unset methods throw, so a test that reaches
 *  one it did not arrange fails loudly instead of silently reading undefined. */
function fakeGateway(over: Partial<SourceGateway> = {}): SourceGateway {
  return {
    fetchAuthoredTweets: () => { throw new Error("not arranged"); },
    fetchThread: async () => { throw new Error("not arranged"); },
    fetchByIds: async () => { throw new Error("not arranged"); },
    fetchArticle: async () => [] as ArticleBlock[],
    fetchUserProfile: async () => { throw new Error("not arranged"); },
    ...over,
  } as SourceGateway;
}

function fakeRepo(initial: CollectedThread[] = []) {
  const rows = [...initial];
  const repo: CollectionRepository & { rows: CollectedThread[] } = {
    rows,
    loadAll: async () => rows,
    upsert: async (threads) => { for (const t of threads) rows.push(t); },
    listActiveTweetIds: async () => [],
    markDeleted: async () => {},
  };
  return repo;
}

const fakeTranslations = (ids: string[] = []): TranslationStore => ({
  loadAll: async () => [],
  upsert: async () => {},
  listTranslatedIds: async () => new Set(ids),
});

const URL_100 = "https://x.com/Mantle_Official/status/100";

describe("CollectLinkedThread", () => {
  it("collects a thread and reports the item id", async () => {
    const repo = fakeRepo();
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet(), tweet({ id: "101" })] }),
      repo,
      fakeTranslations(),
      () => "2026-08-12T09:00:00.000Z",
    );

    const result = await uc.run(URL_100);

    expect(result).toEqual({ itemId: "x:100", tweets: 2, outcome: "collected" });
    expect(repo.rows).toEqual([
      {
        rootId: "100",
        tweets: [tweet(), tweet({ id: "101" })],
        status: "active",
        firstSeenAt: "2026-08-12T09:00:00.000Z",
      },
    ]);
  });

  it("refuses a url that is not an x.com post", async () => {
    const uc = new CollectLinkedThread(fakeGateway(), fakeRepo(), fakeTranslations());
    await expect(uc.run("https://example.com/hello")).rejects.toThrow(INTAKE_BAD_URL);
  });

  it("refuses when the thread comes back empty", async () => {
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [] }),
      fakeRepo(),
      fakeTranslations(),
    );
    await expect(uc.run(URL_100)).rejects.toThrow(INTAKE_NOT_FOUND);
  });

  it("refuses when no assembled thread carries the requested root id", async () => {
    // The gateway answered, but with a different conversation — writing this would file the wrong post.
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet({ id: "999", conversationId: "999" })] }),
      fakeRepo(),
      fakeTranslations(),
    );
    await expect(uc.run(URL_100)).rejects.toThrow(INTAKE_NOT_FOUND);
  });

  it("refuses a thread that opens with a commenter reply", async () => {
    // flattenXThreads drops these silently; refusing here is the whole point.
    const repo = fakeRepo();
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet({ isReply: true, text: "@someone agreed" })] }),
      repo,
      fakeTranslations(),
    );
    await expect(uc.run(URL_100)).rejects.toThrow(INTAKE_REPLY);
    expect(repo.rows).toEqual([]);
  });

  it("lets the gateway's own failure through", async () => {
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => { throw new Error("x api 502"); } }),
      fakeRepo(),
      fakeTranslations(),
    );
    await expect(uc.run(URL_100)).rejects.toThrow("x api 502");
  });

  it("reports already-pending for a thread already collected but not translated", async () => {
    const repo = fakeRepo([
      { rootId: "100", tweets: [tweet()], status: "active", firstSeenAt: "2026-08-01T00:00:00.000Z" },
    ]);
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet()] }),
      repo,
      fakeTranslations(),
    );

    const result = await uc.run(URL_100);

    expect(result.outcome).toBe("already-pending");
    // Re-collected anyway: the thread may have grown a tail since it was first seen.
    expect(repo.rows).toHaveLength(2);
  });

  it("reports already-translated when a translation row exists", async () => {
    const repo = fakeRepo([
      { rootId: "100", tweets: [tweet()], status: "active", firstSeenAt: "2026-08-01T00:00:00.000Z" },
    ]);
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet()] }),
      repo,
      fakeTranslations(["x:100"]),
    );

    expect((await uc.run(URL_100)).outcome).toBe("already-translated");
  });

  it("fetches the article body for an article tweet that arrived without one", async () => {
    const blocks: ArticleBlock[] = [{ type: "paragraph", text: "body" } as unknown as ArticleBlock];
    let asked = "";
    const uc = new CollectLinkedThread(
      fakeGateway({
        fetchThread: async () => [tweet({ article: { title: "t" } as SourceTweet["article"] })],
        fetchArticle: async (id) => { asked = id; return blocks; },
      }),
      fakeRepo(),
      fakeTranslations(),
    );

    await uc.run(URL_100);

    expect(asked).toBe("100");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run tests/app/collectLinkedThread.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/app/CollectLinkedThread"`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/app/CollectLinkedThread.ts`:

```ts
import type { CollectedThread, SourceTweet } from "../domain/models";
import type { CollectionRepository } from "../ports/CollectionRepository";
import type { SourceGateway } from "../ports/SourceGateway";
import type { TranslationStore } from "../ports/TranslationStore";
import { systemClock, type Clock } from "../ports/Clock";
import { parsePostUrl } from "../domain/publish/xReconcile";
import { assembleThreads } from "../domain/threadAssembler";
import { isCommenterReply } from "../adapters/content/XContentSource";

export const INTAKE_BAD_URL = "x.com/<계정>/status/<번호> 형태의 주소가 필요합니다";
export const INTAKE_NOT_FOUND = "그 글을 가져올 수 없습니다 — 삭제됐거나 비공개일 수 있습니다";
export const INTAKE_REPLY = "이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다";

/**
 * What the caller learns about a link it just submitted. `already-*` are not refusals — the thread
 * was re-collected either way (see `run`) — they exist so the screen can say where the item already
 * is instead of implying the click did nothing.
 */
export type IntakeOutcome = "collected" | "already-pending" | "already-translated";

export interface IntakeResult {
  itemId: string;
  tweets: number;
  outcome: IntakeOutcome;
}

/**
 * One x.com link → one row in the collection repository, on the same terms a timeline sweep writes.
 *
 * The one thing this deliberately does NOT do is touch the collect watermark. The watermark means
 * "how far down the timeline `pnpm collect` has read"; a link intake reads no timeline, so advancing
 * it would make the next scheduled sweep skip everything posted in between. `CollectAuthoredContent`
 * makes the same call for its own adhoc runs (`--since`/`--limit`). Not touching it — and not
 * touching the run ledger either — is also what keeps this path off the filesystem entirely, which
 * is what lets it run inside the Vercel function where the FS is read-only.
 *
 * No author filter, on purpose: the point of this entry point is a post the pipeline's own account
 * did not write. `flattenXThreads` has no author condition either, so the item flows on unchanged.
 */
export class CollectLinkedThread {
  constructor(
    private readonly gateway: SourceGateway,
    private readonly repo: CollectionRepository,
    private readonly translationStore: TranslationStore,
    private readonly now: Clock = systemClock,
  ) {}

  async run(url: string): Promise<IntakeResult> {
    const parsed = parsePostUrl(url.trim());
    if (!parsed) throw new Error(INTAKE_BAD_URL);

    const tweets = await this.gateway.fetchThread(parsed.rootId);
    if (tweets.length === 0) throw new Error(INTAKE_NOT_FOUND);

    await this.fillArticleBodies(tweets);

    const thread = assembleThreads(tweets).find((t) => t.rootId === parsed.rootId);
    // The gateway answered, but about a different conversation. Storing it would file the wrong post
    // under the id the operator asked for, which no later stage could detect.
    if (!thread) throw new Error(INTAKE_NOT_FOUND);

    // Refused here rather than left to be dropped downstream. `flattenXThreads` skips a thread whose
    // first tweet is a commenter reply *silently* — collected successfully, then absent from 1차 검수
    // two hours later with no error anywhere for anyone to find.
    if (isCommenterReply(thread.tweets[0])) throw new Error(INTAKE_REPLY);

    const itemId = `x:${parsed.rootId}`;
    const [existing, translatedIds] = await Promise.all([
      this.repo.loadAll(),
      this.translationStore.listTranslatedIds(),
    ]);
    const outcome: IntakeOutcome = translatedIds.has(itemId)
      ? "already-translated"
      : existing.some((t) => t.rootId === parsed.rootId)
        ? "already-pending"
        : "collected";

    // Upserted even when it was already here: the thread may have grown a tail since, and `upsert`
    // preserves `firstSeenAt` while `mergeTweet` protects a stored article body from a re-fetch that
    // came back without one.
    const collected: CollectedThread = {
      rootId: thread.rootId,
      tweets: thread.tweets,
      status: "active",
      firstSeenAt: this.now(),
    };
    await this.repo.upsert([collected]);

    return { itemId, tweets: thread.tweets.length, outcome };
  }

  /** An article's body is a second call — the thread response marks the tweet as an article but
   *  never carries its blocks. Mirrors `CollectAuthoredContent.fillArticleBodies`. */
  private async fillArticleBodies(tweets: SourceTweet[]): Promise<void> {
    for (const t of tweets) {
      if (!t.article || (t.article.blocks?.length ?? 0) > 0) continue;
      t.article = { ...t.article, blocks: await this.gateway.fetchArticle(t.id) };
    }
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/app/collectLinkedThread.test.ts`
Expected: PASS (9 tests)

(`ArticleBody.blocks?: ArticleBlock[]`는 확인됨 — `src/domain/models.ts:51-55`.)

- [ ] **Step 5: 타입 검사**

Run: `pnpm typecheck`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add src/app/CollectLinkedThread.ts tests/app/collectLinkedThread.test.ts
git commit -m "feat(app): collect a single X thread from its url

The pipeline has one door: herald-watch sweeps a timeline every two hours.
A post worth translating that lives outside Mantle_Official has no way in.

This is the missing entry point, built from parts that already exist and are
proven in x:link — parsePostUrl, fetchThread, fetchArticle, assembleThreads,
upsert. It never advances the collect watermark: the watermark records how
far down a timeline the sweep has read, and a link intake reads no timeline,
so moving it would make the next sweep skip the posts in between. Leaving it
(and the run ledger) alone is also what keeps this path off the filesystem,
which is what will let it run inside the Vercel function.

It refuses a commenter reply at the door because flattenXThreads drops those
without a sound: collected successfully, then absent from 1차 검수 two hours
later with nothing anywhere to explain it."
```

---

### Task 2: `/api/intake/*` 라우트

**Files:**
- Modify: `src/adapters/web/apiHandlers.ts` — `ApiDeps`에 필드 둘, `StatusView`에 `intakeEnabled`, `handleApi`에 라우트 둘
- Modify: `tests/support/fakeApiDeps.ts` — 새 필드의 더블
- Modify: `tests/adapters/web/gate.test.ts` — `writeRoutes`/`readRoutes`
- Test: `tests/adapters/web/apiHandlers.test.ts` — 라우트 동작

**Interfaces:**
- Consumes: Task 1의 `CollectLinkedThread`, `IntakeResult`
- Produces:
  ```ts
  // apiHandlers.ts
  export interface IntakePendingItem { itemId: string; text: string; createdAt: string; kind?: "post" | "article" }
  export const INTAKE_DISABLED_MESSAGE: string;
  // ApiDeps 추가 필드
  collectLinkedThread?: CollectLinkedThread;   // 없으면 라우트가 400
  loadIntakePending: () => Promise<IntakePendingItem[]>;  // 항상 존재
  // StatusView 추가 필드
  intakeEnabled: boolean;
  ```

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/adapters/web/apiHandlers.test.ts` 끝에 추가한다 (파일 상단의 `makeDeps` 헬퍼를 그대로 쓴다 — 이름과 시그니처는 파일을 열어 확인할 것):

```ts
describe("POST /api/intake/x", () => {
  it("collects the linked thread and answers with the outcome and the refreshed pending list", async () => {
    const deps = makeDeps({
      collectLinkedThread: {
        run: async (url: string) => {
          expect(url).toBe("https://x.com/someone/status/7");
          return { itemId: "x:7", tweets: 3, outcome: "collected" as const };
        },
      } as unknown as ApiDeps["collectLinkedThread"],
      loadIntakePending: async () => [
        { itemId: "x:7", text: "hello", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" as const },
      ],
    });

    const res = await handleApi(deps, "POST", "/api/intake/x", { url: "https://x.com/someone/status/7" });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      itemId: "x:7",
      tweets: 3,
      outcome: "collected",
      pending: [{ itemId: "x:7", text: "hello", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" }],
    });
  });

  it("turns a use-case refusal into a 400 carrying its message", async () => {
    const deps = makeDeps({
      collectLinkedThread: {
        run: async () => { throw new Error("이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다"); },
      } as unknown as ApiDeps["collectLinkedThread"],
    });

    const res = await handleApi(deps, "POST", "/api/intake/x", { url: "https://x.com/someone/status/7" });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다" });
  });

  it("400s with a reason when the deployment has no X credentials", async () => {
    const deps = makeDeps({ collectLinkedThread: undefined });

    const res = await handleApi(deps, "POST", "/api/intake/x", { url: "https://x.com/someone/status/7" });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: INTAKE_DISABLED_MESSAGE });
  });

  it("400s on a missing or non-string url before reaching the use case", async () => {
    let called = false;
    const deps = makeDeps({
      collectLinkedThread: { run: async () => { called = true; throw new Error("unreachable"); } } as unknown as ApiDeps["collectLinkedThread"],
    });

    const res = await handleApi(deps, "POST", "/api/intake/x", { url: 42 });

    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe("GET /api/intake/pending", () => {
  it("answers the pending list even where intake itself is closed", async () => {
    // The list reads the database only. A deployment with no X key cannot take a link, but the
    // operator can still see what is queued — so this route is not gated on the credential.
    const deps = makeDeps({
      collectLinkedThread: undefined,
      loadIntakePending: async () => [
        { itemId: "x:9", text: "queued", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" as const },
      ],
    });

    const res = await handleApi(deps, "GET", "/api/intake/pending", undefined);

    expect(res.status).toBe(200);
    expect(res.json).toEqual([{ itemId: "x:9", text: "queued", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" }]);
  });
});
```

`INTAKE_DISABLED_MESSAGE`를 테스트 상단 import에 추가한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run tests/adapters/web/apiHandlers.test.ts`
Expected: FAIL — `INTAKE_DISABLED_MESSAGE`가 export되지 않음

- [ ] **Step 3: `ApiDeps`와 `StatusView`에 필드를 더한다**

`src/adapters/web/apiHandlers.ts` 상단 import에 추가:

```ts
import type { CollectLinkedThread } from "../../app/CollectLinkedThread";
```

`StatusView`의 `conversionEnabled` 바로 아래에 추가:

```ts
  /**
   * Whether `POST /api/intake/x` will actually take a link on this deployment — mirrors
   * `deps.collectLinkedThread !== undefined` (`createDeps.ts` computes the one boolean and uses it
   * for both), so the 링크 수집 tab never offers a [넣기] button whose route answers a bare refusal.
   * False means `TWITTERAPI_IO_KEY` is not set here; the pending list still works, since it reads
   * only the database.
   */
  intakeEnabled: boolean;
```

`ApiDeps`의 `prepareConversionRun` 근처에 추가:

```ts
  /**
   * Absent — not a function that refuses every call — when this deployment has no `TWITTERAPI_IO_KEY`,
   * the same shape `sendToOutlet` and `prepareConversionRun` use. The route checks for it before
   * reading the body, so the capability is genuinely missing rather than merely unhelpful.
   */
  collectLinkedThread?: CollectLinkedThread;
  /**
   * Threads sitting in the collection repository with no translation row yet. Always present: it
   * reads the database only, so a deployment that cannot take a link can still show the queue.
   */
  loadIntakePending: () => Promise<IntakePendingItem[]>;
```

`ApiDeps` 위쪽(다른 view 타입들 옆)에 추가:

```ts
/**
 * One row of the 링크 수집 tab's waiting list. A trimmed `ContentItem` — the tab needs to recognise
 * an item, not to review it, and the full source text of an article runs to thousands of characters.
 */
export interface IntakePendingItem {
  itemId: string;
  text: string;
  createdAt: string;
  kind?: "post" | "article";
}

export const INTAKE_DISABLED_MESSAGE = "이 배포에는 TWITTERAPI_IO_KEY가 없어 링크 수집을 할 수 없습니다";
```

- [ ] **Step 4: 라우트를 더한다**

`handleApi` 안, `translations` 분기 **앞**(세션 게이트 뒤 아무 곳이나 — 다른 3-세그먼트 GET 라우트들 옆이 읽기 좋다)에 넣는다:

```ts
  if (segments[1] === "intake" && segments.length === 3) {
    if (method === "GET" && segments[2] === "pending") {
      return { status: 200, json: await deps.loadIntakePending() };
    }

    if (method === "POST" && segments[2] === "x") {
      // Checked before the body is read, the way `convert-prepare` checks `prepareConversionRun`:
      // a deployment without the credential has no intake, and saying so is the whole message.
      if (!deps.collectLinkedThread) return { status: 400, json: { error: INTAKE_DISABLED_MESSAGE } };
      const url = (body as { url?: unknown })?.url;
      if (typeof url !== "string" || url.trim() === "") {
        return { status: 400, json: { error: "url (string) required" } };
      }
      try {
        const result = await deps.collectLinkedThread.run(url);
        // The refreshed list rides along so the tab self-corrects in one round trip — the same
        // reason `sendToOutlet`'s reply carries a rebuilt `board`.
        return { status: 200, json: { ...result, pending: await deps.loadIntakePending() } };
      } catch (err) {
        // The use case's refusals are the operator asking for something impossible (a url that is
        // not a post, a deleted thread, a commenter reply), not a server fault — 400 with the reason
        // so the tab can print it, rather than the 500 an uncaught throw would produce.
        return { status: 400, json: { error: err instanceof Error ? err.message : String(err) } };
      }
    }
  }
```

- [ ] **Step 5: `fakeApiDeps.ts`를 채운다**

`fakeDeps()`의 반환 객체에 추가:

```ts
    collectLinkedThread: { run: async () => ({ itemId: "x:1", tweets: 1, outcome: "collected" as const }) } as unknown as ApiDeps["collectLinkedThread"],
    loadIntakePending: async () => [],
```

같은 파일의 `loadStatus` 더블에 `intakeEnabled: true`를 더한다.

- [ ] **Step 6: `gate.test.ts`에 라우트를 등록한다**

`writeRoutes` 배열에 추가:

```ts
  ["POST", "/api/intake/x"],
```

`readRoutes` 배열에 추가:

```ts
  ["GET", "/api/intake/pending"],
```

- [ ] **Step 7: 테스트와 타입 검사**

Run: `pnpm vitest run tests/adapters/web && pnpm typecheck`
Expected: 전부 PASS. `gate.test.ts`가 새 라우트 둘에 대해 미인증 401을 확인한다.

- [ ] **Step 8: 커밋**

```bash
git add src/adapters/web/apiHandlers.ts tests/adapters/web/apiHandlers.test.ts tests/adapters/web/gate.test.ts tests/support/fakeApiDeps.ts
git commit -m "feat(web): add the /api/intake routes

POST /api/intake/x takes a link, GET /api/intake/pending answers what is
queued. Both live in handleApi, which the local server and the Vercel
function share by import, so one registration reaches both entry points.

The credential gate is on the POST only. Taking a link needs
TWITTERAPI_IO_KEY; listing the queue reads the database, so an install
without the key can still see what is waiting rather than showing a blank
tab that looks broken.

The POST's reply carries the refreshed list, so the tab repaints in one
round trip — the same reason a send reply carries a rebuilt board."
```

---

### Task 3: `createDeps` 배선과 capability 불리언

**Files:**
- Modify: `src/app/createDeps.ts`

**Interfaces:**
- Consumes: Task 1의 `CollectLinkedThread`, Task 2의 `ApiDeps.collectLinkedThread` / `ApiDeps.loadIntakePending` / `StatusView.intakeEnabled`
- Produces: 실행 중인 배포에서 실제로 동작하는 라우트

- [ ] **Step 1: import를 더한다**

```ts
import { CollectLinkedThread } from "./CollectLinkedThread";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { loadConfig } from "../config";
import type { IntakePendingItem } from "../adapters/web/apiHandlers";
```

`src/adapters/content/XContentSource`에서 이미 `xThreadIntake`를 가져오고 있으므로 그 import에 `flattenXThreads`를 더한다.

생성 줄은 이 저장소가 여섯 군데에서 쓰는 것과 글자 그대로 같다(`src/cli/x-link.ts:64` 등):
`new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey))`. 둘째 인자 `{ maxPages }`는
선택이며 `HERALD_COLLECT_MAX_PAGES`를 위한 것이므로 **여기서는 넘기지 않는다** — 그 변수는
`pnpm collect` 한 군데를 위해 문서화돼 있고, 링크 수집이 그것을 읽으면 백필용 override가 엉뚱한
진입점까지 따라온다.

- [ ] **Step 2: 게이트웨이를 자체 try/catch로 만든다**

`conversionEnabled` 정의 바로 아래(`createDeps.ts:176` 근처):

```ts
  /**
   * Whether `POST /api/intake/x` can take a link here — same "computed once, used for both" shape as
   * `sendsEnabled` and `conversionEnabled` above, for the same reason: it decides both whether the
   * dep exists (which is what makes the route refuse) and `StatusView.intakeEnabled` (which is what
   * makes the tab say why before anyone clicks).
   *
   * Constructed in its own try/catch, the way `reconcilePublished` and `headroomReader` guard theirs:
   * `loadConfig()` throws when `TWITTERAPI_IO_KEY` is absent, and an install that never collects —
   * a review-only hosted deployment — must still boot. A throw on this line would take the whole
   * dashboard down over a credential only one tab needs.
   */
  let collectLinkedThread: CollectLinkedThread | undefined;
  try {
    collectLinkedThread = new CollectLinkedThread(
      new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey)),
      stores.collectionRepository,
      translationStore,
    );
  } catch {
    collectLinkedThread = undefined;
  }
  const intakeEnabled = collectLinkedThread !== undefined;
```

`stores`는 `:267`에서, `translationStore`는 그 근처에서 만들어진다 — 이 블록은 **둘 다 만들어진 뒤**에 놓아야 한다. 위치를 정하기 전에 두 변수의 선언 줄을 확인할 것.

- [ ] **Step 3: `loadIntakePending`을 만든다**

```ts
  /**
   * What has been collected but has no translation row yet — the 링크 수집 tab's waiting list.
   *
   * The same negative join `translate:prepare` selects with, through the same function, so the tab
   * cannot show a queue the next tick disagrees with. Trimmed to what the tab renders: an article's
   * source text runs to thousands of characters and the list only needs to be recognisable.
   */
  const loadIntakePending = async (): Promise<IntakePendingItem[]> => {
    const [threads, translatedIds] = await Promise.all([
      stores.collectionRepository.loadAll(),
      translationStore.listTranslatedIds(),
    ]);
    return flattenXThreads(threads, translatedIds).map((item) => ({
      itemId: item.id,
      text: item.text.slice(0, 300),
      createdAt: item.createdAt,
      kind: item.kind,
    }));
  };
```

`IntakePendingItem`을 `apiHandlers`에서 type import 한다.

- [ ] **Step 4: `loadStatus`와 반환 객체에 싣는다**

`loadStatus`의 반환에서 `conversionEnabled,` 바로 아래:

```ts
      intakeEnabled,
```

`createDeps`의 최종 반환 객체에서 `prepareConversionRun,` 근처:

```ts
    collectLinkedThread,
    loadIntakePending,
```

- [ ] **Step 5: 타입 검사와 전체 테스트**

Run: `pnpm typecheck && pnpm test`
Expected: 전부 PASS. `loadStatus`를 만드는 다른 테스트가 `intakeEnabled` 누락으로 깨지면 그 더블에도 더한다.

- [ ] **Step 6: 커밋**

```bash
git add src/app/createDeps.ts
git commit -m "wire(app): construct the link intake behind its own credential guard

The gateway is built in its own try/catch, the way reconcilePublished and
headroomReader build theirs. loadConfig() throws without TWITTERAPI_IO_KEY,
and a review-only deployment that never collects must still boot — a throw
here would take the whole dashboard down over a credential one tab needs.

One boolean decides both whether the dep exists and what StatusView reports,
so the tab and the route cannot disagree about whether this install can take
a link. The pending list is deliberately not behind that guard: it reads the
database, and an operator without the key should still see the queue."
```

---

### Task 4: `App.tsx`의 탭 정의를 한 테이블로

**새 탭은 아직 넣지 않는다.** 순수 리팩터링이고 기존 테스트가 그대로 통과해야 한다.

**Files:**
- Modify: `web/src/App.tsx:12` (`Mode`), `:22` (`modeFromHash`), `:83-89` (`switchMode`), `:344-361` (nav), `:468-502` (렌더 분기)

**Interfaces:**
- Produces:
  ```ts
  type Mode = "translations" | "renderings";
  const TABS: readonly { id: Mode; hash: string; label: string }[];
  const modeFromHash: () => Mode;
  ```

- [ ] **Step 1: 테이블을 만든다**

`type Mode` 선언을 다음으로 대체한다:

```tsx
/**
 * Every tab, once. The four things a tab needs — its id, the hash that addresses it, the label on
 * the button, and the fact that it exists at all — were four separate literals in this file, and a
 * new tab meant finding all four. `modeFromHash` folding *every* unrecognised hash into
 * `"translations"` made the miss silent: a tab whose hash arm was forgotten does not error, it
 * quietly opens 1차 검수 instead.
 *
 * The first entry is the default, and its hash is "" — the bare url is 1차 검수.
 */
const TABS = [
  { id: "translations", hash: "", label: "1차 검수 · 번역" },
  { id: "renderings", hash: "#renderings", label: "2차 검수 · 채널" },
] as const;

type Mode = (typeof TABS)[number]["id"];
```

`modeFromHash`의 본문을 대체한다(위의 doc comment는 그대로 둔다):

```tsx
const modeFromHash = (): Mode => TABS.find((t) => t.hash === window.location.hash)?.id ?? TABS[0].id;
```

`switchMode`의 해시 쓰기 줄을 대체한다:

```tsx
    window.location.hash = TABS.find((t) => t.id === m)?.hash ?? "";
```

nav의 인라인 배열을 대체한다:

```tsx
          <nav className="ml-2 inline-flex shrink-0 rounded-lg border border-line bg-bg p-0.5">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => switchMode(id)}
                className={`whitespace-nowrap rounded-[7px] px-3 py-1 text-[13px] font-medium transition-colors ${
                  mode === id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
```

렌더 분기는 이 태스크에서 **건드리지 않는다** — Task 6에서 세 번째 갈래와 함께 바꾼다.

- [ ] **Step 2: 기존 테스트가 그대로 통과하는지 확인한다**

Run: `pnpm vitest run web/tests && pnpm typecheck:web`
Expected: 전부 PASS. 리팩터링이므로 테스트를 고칠 일이 있으면 안 된다 — 고쳐야 한다면 동작을 바꾼 것이니 되돌린다.

- [ ] **Step 3: 커밋**

```bash
git add web/src/App.tsx
git commit -m "refactor(web): define each dashboard tab in one place

A tab was four separate literals — the Mode union, modeFromHash's ternary,
switchMode's hash write, and the nav's inline array — and modeFromHash folds
every unrecognised hash into \"translations\". So forgetting one of the four
does not error: the new tab quietly opens 1차 검수 instead, which is a bug
that looks like a design decision.

One table, three readers. No behaviour change; the existing tests pass
untouched."
```

---

### Task 5: `IntakeView` 컴포넌트

탭에 아직 연결하지 않는다. 컴포넌트와 API 호출만.

**Files:**
- Create: `web/src/components/IntakeView.tsx`
- Modify: `web/src/api.ts`, `web/src/types.ts`
- Modify: `tests/web/typeMirror.test.ts` (`StatusView.intakeEnabled` 쌍)
- Test: `web/tests/IntakeView.test.tsx`

**Interfaces:**
- Consumes: Task 2의 라우트와 `IntakePendingItem`
- Produces:
  ```tsx
  export function IntakeView(props: { authEpoch: number; intakeEnabled: boolean }): JSX.Element
  // api.ts
  api.intakePending: () => Promise<IntakePendingItem[]>
  api.intakeSubmit: (url: string) => Promise<IntakeReply>
  // types.ts
  export interface IntakePendingItem { itemId: string; text: string; createdAt: string; kind?: "post" | "article" }
  export type IntakeOutcome = "collected" | "already-pending" | "already-translated";
  export interface IntakeReply { itemId: string; tweets: number; outcome: IntakeOutcome; pending: IntakePendingItem[] }
  export const INTAKE_OUTCOME_MESSAGE: Record<IntakeOutcome, string>;
  ```

- [ ] **Step 1: 와이어 타입을 더한다**

`web/src/types.ts`의 `StatusView`에 `conversionEnabled?: boolean;` 아래로:

```ts
  /**
   * `StatusView.intakeEnabled`. Drives whether 링크 수집 offers [넣기] at all. Same optionality as
   * its neighbours: a status payload predating this field reads as absent, not as false.
   */
  intakeEnabled?: boolean;
```

파일 끝에 추가:

```ts
/** One row of 링크 수집's waiting list. Mirrors `IntakePendingItem` in `src/adapters/web/apiHandlers.ts`. */
export interface IntakePendingItem {
  itemId: string;
  text: string;
  createdAt: string;
  kind?: "post" | "article";
}

export type IntakeOutcome = "collected" | "already-pending" | "already-translated";

export interface IntakeReply {
  itemId: string;
  tweets: number;
  outcome: IntakeOutcome;
  pending: IntakePendingItem[];
}

/**
 * What each outcome means on screen. `already-*` are not errors — the thread was re-collected either
 * way — so they read as "where your item already is", never as a rejection.
 */
export const INTAKE_OUTCOME_MESSAGE: Record<IntakeOutcome, string> = {
  collected: "수집됐습니다 — 다음 번역 틱에서 초안이 만들어집니다",
  "already-pending": "이미 들어와 있습니다 — 다음 번역 틱에서 처리됩니다",
  "already-translated": "이미 번역돼 1차 검수에 있습니다",
};
```

`tests/web/typeMirror.test.ts`를 열어 그 파일의 방식대로 `intakeEnabled` 쌍을 등록한다. 형태는 파일이 정한다 — 추측하지 말고 이웃한 `conversionEnabled` 항목을 따라 쓴다.

- [ ] **Step 2: `api.ts`에 호출을 더한다**

`api` 객체 안, `formatItem` 근처:

```ts
  intakePending: () => json<IntakePendingItem[]>("/api/intake/pending"),
  intakeSubmit: (url: string) =>
    json<IntakeReply>("/api/intake/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),
```

`IntakePendingItem`, `IntakeReply`를 이 파일의 type import에 더한다.

- [ ] **Step 3: 실패하는 테스트를 쓴다**

`web/tests/IntakeView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntakeView } from "../src/components/IntakeView";

const PENDING = [{ itemId: "x:9", text: "waiting post", createdAt: "2026-08-12T00:00:00.000Z", kind: "post" as const }];

function stubFetch(extra: Record<string, () => Response> = {}) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (extra[key]) return extra[key]();
    if (key === "GET /api/intake/pending") return new Response(JSON.stringify(PENDING), { status: 200 });
    throw new Error(`unexpected fetch: ${key}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IntakeView", () => {
  it("shows what is already waiting", async () => {
    stubFetch();
    render(<IntakeView authEpoch={0} intakeEnabled={true} />);
    expect(await screen.findByText("waiting post")).toBeTruthy();
  });

  it("submits a link and reports the outcome", async () => {
    stubFetch({
      "POST /api/intake/x": () =>
        new Response(JSON.stringify({ itemId: "x:7", tweets: 2, outcome: "collected", pending: PENDING }), { status: 200 }),
    });
    render(<IntakeView authEpoch={0} intakeEnabled={true} />);
    await screen.findByText("waiting post");

    await userEvent.type(screen.getByRole("textbox"), "https://x.com/someone/status/7");
    await userEvent.click(screen.getByRole("button", { name: "넣기" }));

    expect(await screen.findByText("수집됐습니다 — 다음 번역 틱에서 초안이 만들어집니다")).toBeTruthy();
  });

  it("shows the server's refusal instead of a generic failure", async () => {
    stubFetch({
      "POST /api/intake/x": () =>
        new Response(JSON.stringify({ error: "이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다" }), { status: 400 }),
    });
    render(<IntakeView authEpoch={0} intakeEnabled={true} />);
    await screen.findByText("waiting post");

    await userEvent.type(screen.getByRole("textbox"), "https://x.com/someone/status/7");
    await userEvent.click(screen.getByRole("button", { name: "넣기" }));

    expect(
      await screen.findByText("이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다"),
    ).toBeTruthy();
  });

  it("disables 넣기 and says why when the deployment has no X credentials", async () => {
    stubFetch();
    render(<IntakeView authEpoch={0} intakeEnabled={false} />);
    await screen.findByText("waiting post");

    const button = screen.getByRole("button", { name: "넣기" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("이 배포에는 TWITTERAPI_IO_KEY가 없어 링크 수집을 할 수 없습니다")).toBeTruthy();
  });

  it("keeps the queue visible when intake is closed", async () => {
    // The list reads the database only — an operator without the key should still see what is queued.
    stubFetch();
    render(<IntakeView authEpoch={0} intakeEnabled={false} />);
    expect(await screen.findByText("waiting post")).toBeTruthy();
  });
});
```

- [ ] **Step 4: 실패를 확인한다**

Run: `pnpm vitest run web/tests/IntakeView.test.tsx`
Expected: FAIL — `IntakeView`를 찾을 수 없음

- [ ] **Step 5: 컴포넌트를 만든다**

`web/src/components/IntakeView.tsx`. `RenderingsView.tsx`를 열어 Tailwind 클래스 관례, `btn`(`web/src/buttonStyles.ts`), Tip 컴포넌트가 있는지, `authEpoch` 재조회 effect의 모양을 확인하고 그대로 따른다. 요구되는 동작:

- 마운트 시와 `authEpoch`가 바뀔 때 `api.intakePending()`을 호출한다
- `<input type="text">` + `[넣기]` 버튼. 버튼은 `!intakeEnabled`이거나 입력이 비었거나 요청 중이면 disabled
- `!intakeEnabled`이면 버튼 옆에 `이 배포에는 TWITTERAPI_IO_KEY가 없어 링크 수집을 할 수 없습니다`를 항상 보이게 둔다. **툴팁이나 hover가 아니라 보이는 텍스트여야 한다** — 최근 이 저장소가 disabled 이유를 전부 Tip으로 옮긴 이유와 같다
- 제출이 성공하면 `INTAKE_OUTCOME_MESSAGE[reply.outcome]`을 띄우고, `reply.pending`으로 목록을 갈아끼우고, 입력을 비운다
- 실패하면 `ApiError.message`를 그대로 띄운다
- 목록 위에 다음 번역 틱을 적는다: `번역 틱은 두 시간마다 매시 17분에 돕니다` — 기다리는 시간이 고장이 아니라 일정이라는 것을 화면에서 알 수 있게
- 목록이 비면 `대기 중인 항목이 없습니다`

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run web/tests/IntakeView.test.tsx && pnpm typecheck:web`
Expected: PASS (5 tests)

- [ ] **Step 7: 커밋**

```bash
git add web/src/components/IntakeView.tsx web/src/api.ts web/src/types.ts web/tests/IntakeView.test.tsx tests/web/typeMirror.test.ts
git commit -m "feat(web): build the 링크 수집 view

The waiting list is not decoration. A linked item has no translation row
until the next tick, and 1차 검수 lists translations — so between submitting
a link and the tick two hours later, the item is in the database and visible
nowhere. Without the list the feature reads as \"I pasted it and it vanished\".

The list stays up even where intake is closed: it reads the database, and an
operator without the credential should still see the queue rather than a
blank tab. The reason the button is disabled is visible text next to it, not
a tooltip, for the reason the rest of this dashboard's disabled reasons moved
onto Tip."
```

---

### Task 6: 탭을 연결한다

**Files:**
- Modify: `web/src/App.tsx` — `TABS`에 항목 하나, 렌더 분기
- Modify: `web/tests/App.test.tsx`

**Interfaces:**
- Consumes: Task 4의 `TABS`, Task 5의 `IntakeView`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`web/tests/App.test.tsx` — 파일 상단의 `vi.mock` 블록 옆에 `IntakeView`도 같은 모양(마운트 카운터 포함)으로 mock한다. `RenderingsView` mock을 그대로 본떠 쓴다. 그리고 테스트를 더한다:

```tsx
it("opens 링크 수집 from its hash", async () => {
  stubFetch();
  await act(async () => {
    window.location.hash = "#intake";
  });
  render(<App onSignOut={() => {}} authEpoch={0} />);
  expect(await screen.findByTestId("intake-view")).toBeTruthy();
});

it("switches to 링크 수집 and back without losing 1차", async () => {
  stubFetch();
  await act(async () => {
    window.location.hash = "";
  });
  render(<App onSignOut={() => {}} authEpoch={0} />);

  await userEvent.click(screen.getByRole("button", { name: "링크 수집" }));
  expect(await screen.findByTestId("intake-view")).toBeTruthy();
  expect(window.location.hash).toBe("#intake");
});
```

`data-testid="intake-view"`는 mock이 붙인다 — `RenderingsView` mock이 쓰는 testid 관례를 확인해 맞춘다. 테스트 사이 `window.location.hash`가 새는 것을 막기 위해 `afterEach`에서 비우는 처리가 이미 있는지 확인하고, 없으면 더한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run web/tests/App.test.tsx`
Expected: FAIL — `링크 수집` 버튼이 없음

- [ ] **Step 3: `TABS`에 더하고 렌더 분기를 연다**

```tsx
const TABS = [
  { id: "translations", hash: "", label: "1차 검수 · 번역" },
  { id: "renderings", hash: "#renderings", label: "2차 검수 · 채널" },
  { id: "intake", hash: "#intake", label: "링크 수집" },
] as const;
```

렌더 분기를 2갈래 삼항에서 명시적 분기로 바꾼다. 기존 `mode === "translations" ? (...) : (<RenderingsView ... />)` 를:

```tsx
      {mode === "translations" && (
        <div className="flex min-h-0 flex-1">
          {/* 기존 1차 검수 블록 그대로 */}
        </div>
      )}

      {mode === "renderings" && (
        <RenderingsView
          onDirtyChange={setDirty}
          authEpoch={authEpoch}
          sendsEnabled={status?.sendsEnabled ?? true}
          conversionEnabled={status?.conversionEnabled ?? true}
        />
      )}

      {mode === "intake" && (
        <IntakeView
          authEpoch={authEpoch}
          // Defaults open while `status` has not loaded, the same reason the two flags above do:
          // the route enforces the real gate regardless, so an optimistic default costs a stale tip.
          intakeEnabled={status?.intakeEnabled ?? true}
        />
      )}
```

`IntakeView`를 import한다. `IntakeView`는 편집 상태를 갖지 않으므로 `onDirtyChange`를 받지 않는다.

- [ ] **Step 4: 테스트와 타입 검사**

Run: `pnpm vitest run web/tests && pnpm typecheck:web`
Expected: 전부 PASS

- [ ] **Step 5: 전체 테스트**

Run: `pnpm test && pnpm typecheck`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add web/src/App.tsx web/tests/App.test.tsx
git commit -m "feat(web): add the 링크 수집 tab

Third tab, one table entry, and the two-arm render ternary becomes three
explicit arms — a ternary chain reads worse at three than a list of guards.

intakeEnabled defaults open while status is still loading, matching its two
neighbours: the route is the real gate either way, so an optimistic default
costs a stale tip and nothing else."
```

---

### Task 7: 문서와 배포 준비

**Files:**
- Modify: `.env.example` (§2 수집 절), `docs/ko/capabilities.md`, `docs/ko/review.md`, `docs/ko/artifacts.md`, `docs/ko/setup/vercel.md`, `CHANGELOG.md`

- [ ] **Step 1: `.env.example`**

`TWITTERAPI_IO_KEY`(`:241` 근처) 주석에 한 줄을 더한다: 이 변수가 이제 호스팅 배포에도 필요하며(링크 수집 탭), 없으면 대시보드는 정상 기동하되 그 탭의 [넣기]가 잠긴 채 이유를 표시한다는 것.

- [ ] **Step 2: `docs/ko/capabilities.md`**

- §3 "소스"의 X 항목에 링크 수집을 더한다: 지정 계정 타임라인 수집(`pnpm collect`)에 더해, 대시보드 `링크 수집` 탭에서 x.com 글 주소 하나를 넣어 그 스레드만 파이프라인에 올릴 수 있다는 것. 계정 제한이 없다는 것.
- "실행 환경" 표의 행에 `링크 수집`을 더한다 — 로컬 ○, 호스팅은 `TWITTERAPI_IO_KEY`가 있을 때 ○. `발송` 행이 `HERALD_SENDS_ENABLED`를 적은 것과 같은 모양으로.
- §2 파이프라인 다이어그램의 `[수집]` 줄에 `(또는 대시보드 링크 수집 탭)`을 붙인다.

- [ ] **Step 3: `docs/ko/review.md`**

새 절 `## 6. 링크 수집 — 우리가 고른 글 넣기`를 넣고(기존 §6 "여기서 하지 않는 것"은 뒤로 밀린다), 링크를 넣는 절차, 대기 목록이 뜻하는 것, 왜 1차 검수에 바로 안 나타나는지(다음 번역 틱), 거절 문구 표를 적는다. 이 문서는 터미널 없는 검수자가 읽는다 — CLI 이야기를 넣지 않는다.

- [ ] **Step 4: `docs/ko/artifacts.md`**

"명령어별 입출력" 표의 관례를 따라 링크 수집 항목을 더한다: 읽기 = twitterapi.io, 쓰기 = `x_threads` 한 행. **워터마크와 런 원장을 쓰지 않는다는 것을 명시한다** — 이 표는 무엇이 무엇을 건드리는지가 전부이고, 여기 없으면 다음 사람이 collect와 같다고 가정한다.

- [ ] **Step 5: `docs/ko/setup/vercel.md`**

환경변수 절에 `TWITTERAPI_IO_KEY`를 더한다. **기동 조건이 아니라 선택**이라는 것을 분명히 한다 — `HERALD_TRUST_PROXY`와 다르다. 없으면 링크 수집만 잠긴다.

- [ ] **Step 6: `CHANGELOG.md`**

`## Unreleased` 아래 항목을 더한다. 최근 항목들의 형식과 어조를 그대로 따른다.

- [ ] **Step 7: 문서 검증**

Run: `pnpm test && pnpm typecheck && pnpm typecheck:web`
Expected: 전부 PASS. 이 저장소는 문서 링크나 구조를 검사하는 테스트가 있을 수 있다 — 깨지면 고친다.

- [ ] **Step 8: 커밋**

```bash
git add .env.example docs CHANGELOG.md
git commit -m "docs(ko): record the link intake tab and its one new env var

artifacts.md gets the entry that matters most: this path writes one x_threads
row and touches neither the watermark nor the run ledger. Without that line
the next reader assumes it behaves like collect, and the watermark is exactly
the thing a wrong assumption there would corrupt.

vercel.md says TWITTERAPI_IO_KEY is optional rather than a boot condition —
unlike HERALD_TRUST_PROXY, its absence locks one tab and nothing else."
```

---

## 배포 (계획 밖, 사람이 하는 일)

머지 후 Vercel 프로젝트에 `TWITTERAPI_IO_KEY`를 넣고 재배포해야 링크 수집이 프로덕션에서 열린다. 넣기 전까지 탭은 뜨되 [넣기]가 잠기고 이유가 보인다. 이 저장소는 Vercel 자동 배포가 없으므로 배포는 별도 조치다.

## Self-Review 기록

- **스펙 커버리지:** 유스케이스(T1), 라우트 둘(T2), capability 게이트(T2·T3), 대기 목록(T2·T3·T5), 탭(T4·T6), 거절 문구 전부(T1·T2·T5), 테스트 목록 전부(T1·T2·T5·T6), 배포와 문서(T7). 스펙의 "안 하는 것" 여섯 항목은 어느 태스크에도 없다 — 의도대로다.
- **타입 일관성:** `IntakeOutcome`/`IntakeResult`(T1) → `IntakePendingItem`/`IntakeReply`(T2) → `web/src/types.ts` 거울(T5). `intakeEnabled`는 `StatusView`(T2), `createDeps`(T3), `web/src/types.ts`(T5), `App.tsx`(T6) 네 곳에서 같은 이름.
- **계획을 쓰며 확인한 것:** `ArticleBody.blocks?: ArticleBlock[]`(`src/domain/models.ts:51-55`), `new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey))`(여섯 진입점이 쓰는 형태), `stores.collectionRepository`가 `createDeps.ts:267`에서 이미 만들어짐, `xThreadIntake`가 이미 `XContentSource`에서 import돼 있음.
- **아직 열어 봐야 하는 곳 셋:** `typeMirror.test.ts` 등록 형식(T5 Step 1), `apiHandlers.test.ts`의 `makeDeps` 시그니처(T2 Step 1), `App.test.tsx`의 `RenderingsView` mock이 쓰는 testid 관례(T6 Step 1). 셋 다 이웃 항목을 그대로 본떠 쓴다 — 추측하지 않는다.
