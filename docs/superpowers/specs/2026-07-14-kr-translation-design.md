# 설계: 서브시스템 C — 한글 번역 (agent-assisted)

- **작성일:** 2026-07-14
- **서브시스템:** C — 한글 번역 (`proposal.md` §3)
- **상태:** 설계 확정 대기 → 구현 계획(writing-plans)으로 이어짐
- **브랜치:** `feat/kr-translation` (B `feat/lark-data-collection` 위에 stack — LarkMessage 소비, B 미머지)

> 코드/식별자/주석은 영어, 설명은 한국어. A(X 수집)·B(Lark 수집)에 이어지는 세 번째 서브시스템.
> 모듈 A spec: `docs/superpowers/specs/2026-07-14-x-data-collection-design.md`,
> B spec: `docs/superpowers/specs/2026-07-14-lark-data-collection-design.md`.

---

## 1. 목적

수집된 A(트윗)·B(Lark) 콘텐츠를 한글로 번역한다. **번역 실행 주체는 로컬 Claude(에이전트)**이며
(proposal §3: "각자 로컬 AI Agent로 진행, 추후 Claude API 전환"), 이 서브시스템의 **코드는 번역
'입력 조립'과 '용어집·번역 저장소'를 담당**한다. Claude API는 사용하지 않는다(미래 몫).

## 2. 범위

**포함 (in scope)**
- 수집 결과(A `output/items.json`, B `output/lark-items.json`)를 소스 무관 `ContentItem`으로 통합
- **6요소 프롬프트 조립**: 역할·용어집·스타일가이드·로케일·few-shot(공유 5요소) + 콘텐츠·grounding(아이템별)
- **공유 컨텍스트는 배치당 1회** 조립(아이템마다 6요소를 반복하지 않음)
- 살아있는 **용어집(glossary)** 저장·갱신 + **웹 조사 기반 용어 갱신** 워크플로우
- **few-shot 플라이휠**: 승인된 번역이 few-shot 예시로 승격 → Mantle KR 톤 학습
- 번역 결과 로컬 JSON 저장, id별 멱등 upsert
- phase 1엔 **코드 번역기 없음**(에이전트가 수행). 미래 `ClaudeApiTranslator`는 §13 참조(지금은 YAGNI로 미도입)

**제외 (out of scope)**
- Claude API 호출(코드 자동 번역) — 미래
- §5 아이템별 변환(KOL 브리프·PR) — 1차 검수 이후 단계라 별도 서브시스템
- 드라이브 업로드(D)·검수 대시보드(E)
- 전량 번역 — pending 중 **선택분**(id/필터)만 대상

## 3. 아키텍처

헥사고날. A/B와 동일 원칙. B 위에 stack하며 `src/shared/`(HttpClient는 불필요, store 헬퍼 재사용).

```
src/
  domain/translation/
    contentItem.ts          # ContentItem (source-agnostic 번역 입력)
    models.ts               # GlossaryEntry, StyleGuide, Locale, FewShotExample, Translation
    promptAssembler.ts      # 순수: 공유컨텍스트(5요소)+아이템 → 프롬프트 (I/O 없음)
  ports/
    ContentSource.ts        # loadPending(translatedIds): Promise<ContentItem[]>
    GlossaryStore.ts        # load / upsertEntry
    FewShotStore.ts         # load / add
    TranslationStore.ts     # loadAll / upsert / listTranslatedIds
    TranslationConfig.ts    # loadStyleGuide/Locale (읽기)
  adapters/
    content/
      XContentSource.ts     # output/items.json(CollectedThread) → ContentItem ("x:<rootId>")
      LarkContentSource.ts  # output/lark-items.json(LarkMessage) → ContentItem ("lark:<messageId>")
    store/
      JsonGlossaryStore.ts · JsonFewShotStore.ts · JsonTranslationStore.ts  (shared/store 재사용)
      FileTranslationConfig.ts   # data/style-guide.md, data/locale.json 읽기
  app/
    PrepareTranslations.ts  # pending 선택 → 공유컨텍스트 조립 → 워크시트 출력
    SaveTranslation.ts      # 에이전트 번역 인제스트 → 승인 시 few-shot 승격
  cli/
    translate-prepare.ts · translate-save.ts · glossary.ts
data/                        # git-tracked 살아있는 데이터 (시크릿 아님, output/과 구분)
  glossary.json · style-guide.md · locale.json · few-shot.json
tests/ ...
```

## 4. 도메인 모델

```ts
// domain/translation/contentItem.ts
export interface ContentItem {
  id: string;              // "x:<rootId>" | "lark:<messageId>"
  source: "x" | "lark";
  text: string;            // 번역할 원문 (쓰레드는 트윗을 합쳐 하나로)
  createdAt: string;       // ISO
  refUrl?: string;
}

// domain/translation/models.ts
export interface GlossaryEntry {
  term: string;                                  // 원문 용어
  rule: "translate" | "transliterate" | "keep";  // 한글 번역 / 음차 / 원문 유지
  target?: string;                               // 예: Mainnet → "메인넷"
  note?: string;
  updatedAt: string;
  source?: string;                               // 웹 조사 출처 등
}
export interface StyleGuide { text: string; }    // data/style-guide.md 내용
export interface Locale {                        // data/locale.json
  dateFormat: string; numberFormat: string; currency: string; unit: string; honorific: string;
}
export interface FewShotExample { source: string; target: string; itemId?: string; }
export type TranslationStatus = "translated" | "approved";
export interface Translation {
  itemId: string; source: "x" | "lark";
  sourceText: string; koreanText: string;
  status: TranslationStatus; translatedAt: string; approvedAt?: string;
}
```

## 5. 프롬프트 조립 (순수)

```ts
export interface SharedContext {
  role: string; glossary: GlossaryEntry[]; styleGuide: StyleGuide;
  locale: Locale; fewShots: FewShotExample[];
}
// 공유 컨텍스트 → 프롬프트 헤더 (배치당 1회)
export function assembleSharedContext(ctx: SharedContext): string;
// 아이템 → 콘텐츠 블록 (+ 선택적 grounding)
export function assembleItemBlock(item: ContentItem, grounding?: string): string;
```
- 아이템마다 5요소를 반복하지 않고 헤더에 1회. 아이템 블록엔 id+원문(+grounding)만.

## 6. 포트

```ts
// ports/ContentSource.ts
export interface ContentSource {
  // 아직 번역 안 된(=translatedIds에 없는) 아이템을 반환
  loadPending(translatedIds: Set<string>): Promise<ContentItem[]>;
}
// ports/GlossaryStore.ts
export interface GlossaryStore {
  load(): Promise<GlossaryEntry[]>;
  upsertEntry(entry: GlossaryEntry): Promise<void>;   // term 기준
}
// ports/FewShotStore.ts
export interface FewShotStore { load(): Promise<FewShotExample[]>; add(ex: FewShotExample): Promise<void>; }
// ports/TranslationStore.ts
export interface TranslationStore {
  loadAll(): Promise<Translation[]>;
  upsert(t: Translation): Promise<void>;              // itemId 기준
  listTranslatedIds(): Promise<Set<string>>;
}
// ports/TranslationConfig.ts
export interface TranslationConfig { loadStyleGuide(): Promise<StyleGuide>; loadLocale(): Promise<Locale>; }
```
> phase 1엔 `Translator` 포트를 만들지 않는다(구현·소비자 없는 인터페이스는 YAGNI). 미래 자동 번역
> 시 도입 — §13.

## 7. 유스케이스 & 데이터 흐름

### 7-1. `PrepareTranslations` (`pnpm translate:prepare`)
`run(selector)` — `selector`는 배치를 **반드시 한정**한다(전량 8897개 방지): `{ ids?: string[]; since?: string; limit?: number }`. `PrepareTranslations`가 `loadPending` 결과에 이 선택자를 적용(기본 `limit` 예: 20).
```
translatedIds = translationStore.listTranslatedIds()
pending = contentSource.loadPending(translatedIds)   # 아직 번역 안 된 전부
pending = applySelector(pending, selector)           # ids/since/limit 로 한정 (필수)
ctx = { role, glossary.load(), config.loadStyleGuide(), config.loadLocale(), fewShotStore.load() }
header = assembleSharedContext(ctx)                  # 5요소 1회
worksheet = header + pending.map(assembleItemBlock)  # 아이템별 콘텐츠
write output/translation-batch-<ts>.md (worksheet) + output/translation-pending.json (id+text)
```
→ **에이전트(로컬 Claude)가 워크시트를 읽고 각 아이템을 한글로 번역.**

### 7-2. `SaveTranslation` (`pnpm translate:save`)
```
translationStore.upsert({ itemId, koreanText, status:"translated", ... })
# 승인 플래그면 status="approved" + fewShotStore.add({ source, target, itemId })  (few-shot 플라이휠)
```

### 7-3. 용어집 웹 조사 갱신 (`pnpm glossary` + 에이전트)
```
에이전트가 WebSearch로 트렌드/신규 크립토·Mantle 용어 조사
 → 후보 제시 → glossaryStore.upsertEntry({ term, rule, target, source, updatedAt })
(정기·비정기. 사람이 최종 확인)
```

## 8. 에러/멱등

- 번역 저장은 `itemId` 기준 upsert → 재실행 안전. 이미 번역된 항목은 `loadPending`에서 제외.
- glossary/few-shot/translation 스토어는 `shared/store`의 원자적 쓰기·손상읽기 거부 헬퍼 재사용.
- 조립은 순수 → I/O 실패 지점이 스토어/CLI에 국한.

## 9. 라이브러리 / 스택

- A/B와 동일: TypeScript(ESM)·pnpm·Node 24·`zod`·네이티브 `fetch`(웹조사는 에이전트 WebSearch, 코드
  아님)·`vitest`·`tsx`. 신규 런타임 의존성 없음.

## 10. 설정 / 데이터

- `data/`(git-tracked, 시크릿 아님): `glossary.json`, `style-guide.md`, `locale.json`, `few-shot.json`.
  초기값은 KR 팀이 채움. `output/`(gitignore)엔 워크시트·pending·번역 결과.
- 시크릿 없음(API 미사용).

## 11. 테스트 전략 (TDD)

- 순수: `promptAssembler`(공유컨텍스트 1회·아이템 블록·grounding 유무), ContentItem 매핑
  (트윗 쓰레드 텍스트 합치기 / Lark 메시지).
- ContentSource: `XContentSource`가 `output/items.json`(active만), `LarkContentSource`가
  `output/lark-items.json`을 정확히 `ContentItem`으로 매핑, `translatedIds` 제외.
- 스토어: glossary upsert(term 기준)·few-shot add·translation upsert(itemId)·listTranslatedIds.
- 유스케이스: `PrepareTranslations`(pending 선택·공유컨텍스트 조립·워크시트), `SaveTranslation`
  (인제스트·승인 시 few-shot 승격) — fake로.

## 12. CLI

- `pnpm translate:prepare [--source x|lark] [--ids …] [--since …]` → 워크시트 생성.
- `pnpm translate:save --id <id> --file <korean.txt> [--approve]` → 번역 인제스트(+few-shot 승격).
- `pnpm glossary` → 용어집 조회/추가(에이전트 웹조사 갱신 창구).

## 13. 향후 확장 (이 서브시스템 밖)

- **자동 번역**: `Translator` 포트(`translate(prompt): Promise<string>`)를 그때 도입하고 `ClaudeApiTranslator`
  어댑터 추가(prepare가 만든 프롬프트를 그대로 재사용). phase 1은 에이전트가 그 자리를 대신함.
- **D 드라이브 업로드**: 번역 결과를 드라이브로.
- **§5 아이템별 변환**(KOL·PR): 별도 서브시스템, 같은 프롬프트 조립 패턴 재사용.
