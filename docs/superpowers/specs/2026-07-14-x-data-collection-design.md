# 설계: 모듈 A — X 데이터 수집 (twitterapi.io)

- **작성일:** 2026-07-14
- **서브시스템:** A — X 데이터 수집 (`proposal.md` §1)
- **상태:** 설계 확정 대기 → 구현 계획(writing-plans)으로 이어짐

> 코드/식별자/주석은 영어, 설명은 한국어. 이 문서는 `mantle-kr-herald` 파이프라인의 첫
> 서브시스템 설계입니다. 전체 분해는 `design/social-media-automation-proposal.md`
> (로컬 전용, git 미추적) 및 헥사고날 가이드(`docs/architecture/hexagonal-architecture.md`) 참고.

---

## 1. 목적

`Mantle_Official`이 X에 **직접 쓴 글**을 수집하여, 이후 파이프라인(번역·포매팅·발행)의
**원천 데이터**로 삼는다. Phase 1은 Kyle의 로컬에서 수동 실행되며, 결과는 로컬 JSON으로
출력한다(드라이브 업로드는 별도 서브시스템 D).

## 2. 범위

**포함 (in scope)**
- `Mantle_Official`이 직접 작성한 트윗 수집
- 쓰레드(self-reply 체인) 재구성 → 하나의 단위로 묶기
- 증분 수집 (watermark 기반, 새 글만)
- 삭제 반영 (soft-mark): 오피셜이 지운 트윗을 재확인해 `status=deleted`로 표시
- 로컬 JSON 저장

**제외 (out of scope)**
- 리트윗, 멘션, 타인의 댓글 수집
- 드라이브/시트 업로드 (서브시스템 D, G)
- 번역 (서브시스템 C)
- 스케줄링/자동 실행 (Phase 1은 수동 CLI)

**미확정 → probe로 확인**
- 인용 리트윗(quote-retweet)이 authored 수집 결과에 딸려오는지 여부. 도메인 결정을 하지
  않고, `quoteRetweet.probe.test.ts`로 실제 응답을 관찰해 문서화만 한다.

## 3. 아키텍처

헥사고날(Ports & Adapters). 의존성은 항상 안쪽(`domain`)을 향한다. 상세 규칙은
`docs/architecture/hexagonal-architecture.md` §4 참조.

```
src/
  domain/
    models.ts               # SourceTweet, CollectedThread, CollectionStatus
    threadAssembler.ts      # self-reply 체인 → CollectedThread (순수 함수)
  ports/
    SourceGateway.ts        # fetchAuthoredTweets, fetchThread, fetchByIds
    CollectionRepository.ts # loadAll, upsert, listActiveTweetIds, markDeleted
    WatermarkStore.ts       # get, set
  adapters/
    twitterapi/
      IHttpClient.ts        # HTTP 포트 (twitterapi-io 이식)
      HttpClient.ts         # retry/backoff/error-map (twitterapi-io 이식)
      TwitterClient.ts      # x-api-key 어댑터
      schemas.ts            # zod schemas: twitterapi.io 응답 검증
      TwitterApiSourceGateway.ts   # SourceGateway 구현
    store/
      LocalJsonStore.ts     # CollectionRepository + WatermarkStore 구현 (output/)
  app/
    CollectAuthoredContent.ts    # 유스케이스: 증분 수집
    ReconcileDeletions.ts        # 유스케이스: 삭제 재확인
  cli/
    collect.ts              # composition root
    reconcile.ts            # composition root
  config.ts                 # env 로딩 (TWITTERAPI_IO_KEY)
tests/
  domain/threadAssembler.test.ts
  adapters/quoteRetweet.probe.test.ts
  app/collectAuthoredContent.test.ts
  app/reconcileDeletions.test.ts
```

## 4. 도메인 모델

```ts
// domain/models.ts
export type CollectionStatus = "active" | "deleted";

export interface SourceTweet {
  id: string;
  text: string;
  createdAt: string;        // ISO 8601 (UTC)
  url: string;
  authorUserName: string;
  inReplyToId?: string;     // self-reply 체인 판별에 사용
  media?: MediaItem[];      // 번역/포매팅에 필요한 첨부
  metrics?: TweetMetrics;   // like/retweet/reply/quote/view (성과용, 있으면 보존)
}

export interface MediaItem {
  type: "photo" | "video" | "animated_gif";
  url: string;
}

export interface TweetMetrics {
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  quoteCount?: number;
  viewCount?: number;
}

export interface CollectedThread {
  rootId: string;           // 쓰레드 첫 트윗 id (단일 트윗이면 그 자신)
  tweets: SourceTweet[];    // 시간순 정렬
  status: CollectionStatus;
  firstSeenAt: string;      // 우리가 처음 수집한 시각 (ISO)
  deletedAt?: string;       // soft-mark 시각 (ISO), status=deleted일 때만
}
```

`threadAssembler`는 **순수 함수**로, `SourceTweet[]`를 받아 `inReplyToId`가 같은 저자
자신을 가리키는 체인을 이어 붙여 `CollectedThread[]`로 만든다. 단일 트윗은 자기 자신이
root인 길이-1 쓰레드가 된다. I/O를 하지 않으므로, 쓰레드 gap 보강(누락된 앞부분을
`fetchThread`로 채우는 것)은 **유스케이스가 먼저 수행한 뒤** 완성된 트윗 집합을 이 함수에
넘긴다(§7-1 참조).

## 5. 포트

```ts
// ports/SourceGateway.ts
export interface SourceGateway {
  // 증분 수집: sinceTime 이후 authored 트윗을 스트리밍
  fetchAuthoredTweets(userName: string, sinceTime?: string): AsyncGenerator<SourceTweet>;
  // 쓰레드 보강: root/구성 트윗 id로 쓰레드 전체 조회
  fetchThread(tweetId: string): Promise<SourceTweet[]>;
  // 삭제 재확인: id 배치를 조회, 살아있는 트윗만 반환
  fetchByIds(ids: string[]): Promise<SourceTweet[]>;
}
```

```ts
// ports/CollectionRepository.ts
export interface CollectionRepository {
  loadAll(): Promise<CollectedThread[]>;
  upsert(threads: CollectedThread[]): Promise<void>;   // rootId 기준 병합
  listActiveTweetIds(): Promise<string[]>;             // status=active 트윗 id 전체
  markDeleted(tweetIds: string[], deletedAt: string): Promise<void>;
}
```

```ts
// ports/WatermarkStore.ts
export interface WatermarkStore {
  get(): Promise<string | undefined>;   // 마지막 수집 지점 (ISO time)
  set(time: string): Promise<void>;
}
```

포트는 작게 유지한다(ISP). `CollectionRepository`와 `WatermarkStore`는 관심사가 다르므로
분리하되, Phase 1에선 하나의 어댑터(`LocalJsonStore`)가 둘 다 구현한다.

## 6. 어댑터

### 6-1. `twitterapi/` — 외부 API
- `IHttpClient` / `HttpClient` / `TwitterClient`: twitterapi-io에서 이식. `HttpClient`의
  retry(429/5xx 지수 백오프)·에러 매핑(401 키오류, 402 크레딧 부족)을 그대로 재사용.
- `schemas.ts`: twitterapi.io 응답을 zod로 검증. 엔드포인트별 shape 차이를 경계에서 흡수.
- `TwitterApiSourceGateway`:
  - `fetchAuthoredTweets`: `GET /twitter/tweet/advanced_search`,
    `query = "from:Mantle_Official"` + `since:<watermark>` (커서 페이지네이션).
  - `fetchThread`: `GET /twitter/tweet/thread_context?tweetId=`.
  - `fetchByIds`: `GET /twitter/tweets?tweet_ids=` (배치, 존재 확인용).
  - 응답을 zod로 검증 후 `SourceTweet`로 정규화.

### 6-2. `store/LocalJsonStore` — 로컬 영속화
- `output/` 아래 JSON 파일 2개: `items.json`(CollectedThread[]), `state.json`(watermark).
- `upsert`는 `rootId` 기준 병합. 기존 항목의 `firstSeenAt`은 보존.
- 나중에 `GoogleDriveSink` 등으로 교체 가능 (같은 포트 구현).

## 7. 유스케이스 & 데이터 흐름

### 7-1. `CollectAuthoredContent` (`pnpm collect`)
```
since = watermark.get()
tweets = []
for await t of source.fetchAuthoredTweets("Mantle_Official", since): tweets.push(t)

// gap 보강 (유스케이스에서 I/O 수행): self-reply인데 그 부모가 이번 배치에 없으면
// (watermark 이전이라 잘렸을 수 있음) thread_context로 앞부분을 채운다.
for t in tweets where t.inReplyToId and t.inReplyToId not in tweets.ids:
    tweets += source.fetchThread(t.id)

threads = assembleThreads(dedupById(tweets))    // 순수 함수, I/O 없음
repo.upsert(threads)         // rootId 기준 병합, status=active, firstSeenAt 기록
if threads not empty:
    watermark.set(max(createdAt))   // 저장 성공 후에만 전진 (재시도 안전)
```
`since:` 경계 트윗을 중복 수집할 수 있으나 `upsert`가 `rootId` 기준 병합이라 멱등하다.

### 7-2. `ReconcileDeletions` (`pnpm reconcile`)
```
activeIds = repo.listActiveTweetIds()
alive = set()
for batch in chunk(activeIds, N):
    for t in source.fetchByIds(batch): alive.add(t.id)
missing = activeIds - alive
repo.markDeleted(missing, now())    // soft-mark, 저장본은 보존
```
멱등(idempotent): 같은 상태에서 여러 번 실행해도 결과 동일.

## 8. 증분 & 삭제 시맨틱

- **Watermark**: 마지막으로 수집한 트윗 중 가장 최신 `createdAt`(ISO/UTC). 다음 실행은
  `since:` 로 그 이후만 요청. 저장 성공 후에만 전진하므로, 중간 실패는 다음 실행이 이어받음.
- **삭제**: 수집 경로는 삭제를 모른다(새 글만 봄). 삭제 반영은 `reconcile`이 담당하며
  soft-mark만 한다 — 저장본을 지우지 않고 `status=deleted` + `deletedAt` 기록. 이미 번역/
  발행된 건의 이력이 보존되고, 대시보드(E)에서 "원본 삭제됨" 배지를 띄울 수 있다.

## 9. 에러 처리

- HTTP 레이어: 429/5xx → 지수 백오프 재시도(최대 3회, twitterapi-io 방식). 401 → API 키
  오류, 402 → 크레딧 부족을 명시적 에러로 변환.
- zod 검증 실패: 어댑터 경계에서 명확한 에러로 던짐(어떤 필드가 어긋났는지 포함).
- 부분 실패: watermark를 저장 성공 후에만 전진시켜, 중복·누락 없이 재개 가능.
- `reconcile`은 멱등이므로 실패 후 재실행 안전.

## 10. 라이브러리 / 스택

- **런타임 dep:** `zod` (외부 응답 검증) — 유일한 런타임 의존성.
- **dev dep:** `typescript`, `@types/node`, `tsx`(TS 실행), `vitest`(테스트).
- **HTTP:** 네이티브 `fetch` (라이브러리 없음).
- **env:** Node 24 네이티브 `--env-file=.env` (dotenv 불필요).
- **모듈:** ESM (`"type": "module"`), `target: ES2022`, Node 24, pnpm.
- **선택(옵션):** `@biomejs/biome` lint+format — 필수 아님.

## 11. 설정 / 시크릿

- `TWITTERAPI_IO_KEY`를 `.env`에서 로딩 (`.env.example` 제공, `.env`는 gitignore).
- 키/쿠키/프록시 등 시크릿은 절대 로그·커밋하지 않음.
- `output/`은 gitignore.

## 12. 테스트 전략 (TDD)

- `threadAssembler.test.ts`: 순수 로직 단위 테스트 (단일 트윗, 쓰레드, gap 보강 케이스).
- `quoteRetweet.probe.test.ts`: 인용 리트윗이 authored 수집에 포함되는지 실제 관찰·문서화.
- `TwitterApiSourceGateway`: fake `IHttpClient`(인메모리 고정 응답)로 정규화·페이지네이션 검증.
- `CollectAuthoredContent`/`ReconcileDeletions`: fake `SourceGateway` + 인메모리 repo/watermark로
  증분·soft-mark·watermark 전진·멱등성 검증.

## 13. CLI

- `pnpm collect` → `CollectAuthoredContent` 실행 (기본 대상 `Mantle_Official`).
- `pnpm reconcile` → `ReconcileDeletions` 실행.
- 조립(어댑터 주입)은 `cli/*.ts` composition root에서만.

## 14. 향후 확장 (이 서브시스템 밖)

- **D. 드라이브 업로드:** `CollectionRepository`의 새 어댑터(`GoogleDriveStore` 등).
- **B. Lark 수집:** 같은 `SourceGateway`를 구현하는 `LarkSourceGateway`.
- **자동화:** collect/reconcile 스케줄링.
- 유스케이스·도메인은 위 확장에도 무수정.
