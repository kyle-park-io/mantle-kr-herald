# 설계: 서브시스템 B — Lark 데이터 수집 (Lark IM API)

- **작성일:** 2026-07-14
- **서브시스템:** B — Lark 데이터 수집 (`proposal.md` §1)
- **상태:** 설계 확정 대기 → 구현 계획(writing-plans)으로 이어짐

> 코드/식별자/주석은 영어, 설명은 한국어. 모듈 A(X 수집)에 이어지는 두 번째 소스. 전체 분해는
> `design/social-media-automation-proposal.md`(로컬 전용) 및 헥사고날 가이드
> (`docs/architecture/hexagonal-architecture.md`) 참고. 모듈 A 설계:
> `docs/superpowers/specs/2026-07-14-x-data-collection-design.md`.

---

## 1. 목적

대상 Lark 그룹("Mantle News Announcement & MKT Task 2.0")의 메시지를 수집하여, 이후 파이프라인
(번역·포매팅·발행)의 **원천 데이터**로 삼는다. Phase 1은 로컬에서 수동 실행되며, 결과는 로컬
JSON으로 출력한다(드라이브 업로드는 별도 서브시스템 D).

## 2. 범위

**포함 (in scope)**
- 설정된 대상 그룹(들)의 chat_id 리스트에서 메시지 수집
- **text·post(리치텍스트)** 메시지만 수집 = 번역할 원문. 이미지/파일 등은 제외(첨부 메타는 보존 X)
- 증분 수집 (per-chat watermark, `create_time` 기준)
- 로컬 JSON 저장
- 범용 인프라(`HttpClient`, 원자적 JSON 저장/watermark)를 `shared/`로 추출해 모듈 A와 공용

**제외 (out of scope)**
- image/file/audio 등 비텍스트 메시지 타입
- 메시지 전송/수정 등 쓰기 작업
- 드라이브/시트 업로드 (서브시스템 D/G), 번역 (서브시스템 C)
- 스케줄링/자동 실행 (Phase 1은 수동 CLI)
- 채팅 목록 자동 발견 — chat_id는 설정으로 주입 (Kyle이 프로비저닝, §11)

## 3. 아키텍처

헥사고날(Ports & Adapters). 모듈 A와 동일 원칙. Lark는 tweet과 데이터 모델·접근 패턴이 달라
**모듈 A의 `SourceGateway`(tweet 전용)를 재사용하지 않고 별도 평행 스택**으로 둔다. 진짜 범용인
저수준 인프라만 `shared/`로 추출해 공유한다(YAGNI: 소스 간 콘텐츠 추상 통합은 번역(C) 단계로 미룸).

```
src/
  shared/
    http/IHttpClient.ts        # HTTP 포트 (모듈 A에서 이관)
    http/HttpClient.ts         # retry/backoff/params/JSON, 범용 에러 (모듈 A에서 이관)
    store/jsonFile.ts          # 원자적 read/write + 손상읽기 거부 (LocalJsonStore에서 추출)
    store/WatermarkStore.ts    # watermark 포트 (모듈 A에서 이관)
  domain/
    larkMessage.ts             # LarkMessage 모델 + extractText (순수, I/O 없음)
  ports/
    LarkSourceGateway.ts       # fetchMessages(chatId, sinceTime?)
    LarkRepository.ts          # loadAll, upsert (messageId 기준)
  adapters/
    lark/
      LarkAuth.ts              # tenant_access_token 발급·캐시·만료 갱신
      LarkClient.ts            # Bearer 주입 + Lark 엔벨로프(code!=0) 해석 (shared HttpClient 위)
      schemas.ts               # zod: Lark 응답 검증 + 정규화(create_time→ISO, content 파싱)
      LarkSourceGateway.ts     # im/v1/messages 페이지네이션 구현
      LarkLocalStore.ts        # LarkRepository + per-chat WatermarkStore (output/)
  app/
    CollectLarkMessages.ts     # 유스케이스: 대상 chat별 증분 수집
  cli/
    collect-lark.ts            # composition root
  config.ts                    # + loadLarkConfig(): appId, appSecret, baseUrl, chatIds[]
tests/
  domain/larkMessage.test.ts
  adapters/lark/larkAuth.test.ts
  adapters/lark/larkSchemas.test.ts
  adapters/lark/larkSourceGateway.test.ts
  adapters/lark/larkLocalStore.test.ts
  adapters/lark/larkAuth.probe.test.ts     # 라이브, 키 없으면 skip
  app/collectLarkMessages.test.ts
```

### 3-1. `shared/` 추출 (모듈 A 리팩터)
- 모듈 A의 `adapters/twitterapi/{IHttpClient,HttpClient}.ts` → `shared/http/`로 이동. 저수준
  `HttpClient`의 에러 메시지는 **범용화**한다(`HTTP <status>: <detail>`, 401/402는 일반 힌트 포함).
  기존 twitterapi 전용 문구("top up at twitterapi.io/dashboard" 등)는 **의도적으로 유지하지 않는다** —
  상태 코드와 서버의 `detail`이 그대로 노출되므로 운영 메시지는 충분히 명확하며, vendor 문구를
  `TwitterClient` 층에 문자열 매칭으로 복원하는 것은 취약하다고 판단(최종 리뷰에서 이 선택을 수용).
- 모듈 A의 `LocalJsonStore`의 원자적 read/write + 손상읽기 거부 로직 → `shared/store/jsonFile.ts`
  헬퍼로 추출, `LocalJsonStore`가 이를 사용하도록 이관. `WatermarkStore` 포트 → `shared/store/`.
- 이 이관은 **모듈 A의 기존 테스트로 보증**(그린 유지). B 브랜치에서 전체 스위트 + CI로 재검증 후 머지.

## 4. 도메인 모델 & content 추출 (순수)

```ts
// domain/larkMessage.ts
export interface LarkMessage {
  messageId: string;
  chatId: string;
  msgType: string;        // "text" | "post" (수집 대상); 원본 그대로 보존
  createdAt: string;      // create_time(ms) → ISO 8601 UTC
  senderId?: string;
  threadId?: string;
  parentId?: string;
  text: string;           // 번역용 평문
  rawContent: string;     // 원본 body.content (JSON 문자열) 보존
}

// 순수: msg_type + content(JSON 문자열) → 평문
export function extractText(msgType: string, content: string): string;
```
- `text` → `JSON.parse(content).text`
- `post` → 리치텍스트 트리(`content`)를 순회해 텍스트 노드만 이어붙임(평탄화)
- 그 외 → `""` (rawContent는 항상 보존)

## 5. 포트

```ts
// ports/LarkSourceGateway.ts
export interface LarkSourceGateway {
  // 한 chat의 sinceTime(ISO) 이후 메시지를 스트리밍 (페이지네이션)
  fetchMessages(chatId: string, sinceTime?: string): AsyncGenerator<LarkMessage>;
}

// ports/LarkRepository.ts
export interface LarkRepository {
  loadAll(): Promise<LarkMessage[]>;
  upsert(messages: LarkMessage[]): Promise<void>;   // messageId 기준 병합, 멱등
}

// shared/store/WatermarkStore.ts — per-chat 키 지원
export interface WatermarkStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, time: string): Promise<void>;
}
```
> 모듈 A의 `WatermarkStore`는 단일 키였다. `shared/`로 옮기며 `key` 파라미터를 추가해 per-chat
> (Lark)와 단일(모듈 A는 고정 키 사용) 양쪽을 지원한다.

## 6. 인증 & 클라이언트

### 6-1. `LarkAuth` — 토큰 캐싱
- `getToken(): Promise<string>` — 캐시된 `tenant_access_token` 반환. 없거나 만료 임박(만료 60초 전)
  이면 `POST /open-apis/auth/v3/tenant_access_token/internal` (body `{app_id, app_secret}`)으로 재발급.
- 응답 `{code, msg, tenant_access_token, expire}`. `expire`(초, ≤7200)로 캐시 만료 시각 계산.
- `code != 0`이면 에러(code+msg).

### 6-2. `LarkClient` — Bearer + 엔벨로프 해석
- shared `HttpClient` 위에 매 요청 `Authorization: Bearer <getToken()>` 주입.
- Lark는 실패도 HTTP 200 + `{code!=0, msg}`로 오는 경우가 많음 → 응답 `code != 0`이면 에러 변환.
- 인증 만료(401 또는 code가 토큰 무효)면 토큰 1회 강제 갱신 후 재시도.

## 7. 유스케이스 & 데이터 흐름

### 7-1. `CollectLarkMessages` (`pnpm collect-lark`)
```
for each chatId in config.chatIds:
  since = watermark.get(chatId)
  msgs = []
  for await m of source.fetchMessages(chatId, since): msgs.push(m)   # 아래 페이지네이션
  repo.upsert(msgs)                       # messageId 기준, 멱등
  maxCreatedAt = max(m.createdAt)
  if msgs not empty and maxCreatedAt > since: watermark.set(chatId, maxCreatedAt)
```

### 7-2. `LarkSourceGateway.fetchMessages` (페이지네이션)
```
GET /open-apis/im/v1/messages
    ?container_id_type=chat&container_id=<chatId>
    &sort_type=ByCreateTimeAsc
    &start_time=<floor(sinceTime/1000)>   (sinceTime 있을 때만)
    &page_size=50
    (&page_token=<cursor>)  while data.has_more
filter item.msg_type ∈ {text, post}
normalize → LarkMessage (createdAt = ISO(create_time ms), text = extractText(...))
```

## 8. 증분 & 시맨틱

- **Watermark**: chat별로 마지막 수집 메시지의 최신 `create_time`(ISO). 다음 실행은 `start_time`으로
  그 이후만. 저장 성공 후에만 전진(재시도 안전) — 모듈 A와 동일 원칙.
- **저장**: `output/lark-items.json`(LarkMessage[]) + `output/lark-state.json`(chatId→watermark 맵).
- **멱등**: `upsert`는 messageId 기준 병합 → 경계 재수집 중복 없음. (모듈 A의 데이터-유실 방지 union
  패턴과 동일하게, 저장본을 잃지 않는다.)

## 9. 에러 처리

- shared HttpClient: 429/5xx → 지수 백오프 재시도(최대 3회). Lark rate limit(50/s·1000/min) 대응.
- Lark 엔벨로프: `code != 0` → code+msg를 담은 에러.
- 토큰 만료 → `LarkClient`가 1회 갱신 후 재시도.
- zod 검증 실패 → 어댑터 경계에서 명확한 에러.
- watermark는 저장 성공 후에만 전진.

## 10. 라이브러리 / 스택

- 모듈 A와 동일 스택 재사용: TypeScript(ESM) · pnpm · Node 24 · `zod`(런타임 유일 의존성) · 네이티브
  `fetch` · `vitest` · `tsx`. 신규 런타임 의존성 없음.

## 11. 설정 / 시크릿 / 프로비저닝 (Kyle 준비 항목) 📌

`.env`(gitignore) — `.env.example`에 템플릿 추가됨:
- `LARK_APP_ID`, `LARK_APP_SECRET` — Lark 커스텀 앱 자격증명
- `LARK_CHAT_IDS` — 대상 그룹 chat_id(들), 콤마 구분
- `LARK_BASE_URL` — 선택, 기본 `https://open.larksuite.com` (Feishu면 `https://open.feishu.cn`)

**Kyle 프로비저닝 체크리스트:**
1. Lark Developer Console에서 **커스텀 앱 생성** → App ID / App Secret 확보
2. 스코프 승인: **`im:message.history:readonly`**(또는 `im:message:readonly`)
3. 앱/봇을 **대상 그룹에 추가** (Mantle News Announcement & MKT Task 2.0)
4. 대상 그룹의 **chat_id** 확보·전달 (그룹 1개인지 2개인지 확정)
5. 리전 확인: Larksuite 국제판(`open.larksuite.com`) vs Feishu(`open.feishu.cn`)

## 12. 테스트 전략 (TDD)

- `larkMessage.test.ts`: `extractText` 순수 테스트(text, post 평탄화, 기타→"").
- `larkAuth.test.ts`: fake HttpClient로 토큰 발급·캐시 재사용·만료 갱신.
- `larkSchemas.test.ts`: 실제 형태의 raw 응답 → LarkMessage 정규화, create_time→ISO, code!=0 에러.
- `larkSourceGateway.test.ts`: fake HttpClient로 페이지네이션(page_token/has_more)·msg_type 필터·정규화.
- `larkLocalStore.test.ts`: per-chat watermark·upsert 멱등(shared store 헬퍼 재사용).
- `collectLarkMessages.test.ts`: fake gateway + in-memory repo/watermark로 chat별 증분·watermark 전진.
- `larkAuth.probe.test.ts`: `LARK_APP_ID/SECRET` 없으면 skip; 있으면 실제 토큰 발급 + 메시지 목록
  형태 검증(라이브).
- shared 이관 테스트: 모듈 A의 HttpClient·LocalJsonStore 테스트가 `shared/` 위치에서 그린 유지.

## 13. CLI

- `pnpm collect-lark` → `CollectLarkMessages` 실행 (config의 모든 chat_id 대상).
- 조립(어댑터 주입)은 `cli/collect-lark.ts` composition root에서만.

## 14. 향후 확장 (이 서브시스템 밖)

- **D. 드라이브 업로드:** `LarkRepository`의 새 어댑터.
- **C. 번역:** X(SourceTweet)·Lark(LarkMessage) 두 콘텐츠를 번역 유스케이스가 소비. 이때 공통 콘텐츠
  추상이 정당해지면 도입(지금은 YAGNI).
- **자동화:** collect-lark 스케줄링.
