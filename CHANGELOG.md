# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Upgrading — action required for existing installs

- **보드에 `발송 · 잠김`이 늘어 보일 수 있습니다 — 대부분 정상입니다.** 발송이 원문 번역의 승인까지
  확인하기 시작했으므로, 승인이 취소된 번역이나 **문구를 승인한 뒤에 다시 승인된** 번역에 딸린 방은
  이제 잠깁니다. 줄 아래 노란 글씨가 어느 쪽인지 알려주고, 읽어보고 괜찮으면 `승인 ✓`를 다시 누르면
  풀립니다. 지워지는 것은 없습니다. 다만 **`approvedAt`이 없는 오래된 승인 렌더링·포크**가 있다면 —
  승인 시각을 비교할 수 없으므로 `원문이 이 문구를 승인한 뒤에 다시 승인됐습니다`로 잠깁니다. 이때도
  고칠 것은 `승인 ✓` 한 번뿐입니다.
- **발송처 축(PR #80)을 건너뛰고 그 이전 버전에서 곧장 올라온 설치본은, 대시보드를 처음 열었을 때
  맨틀 한국 데브방이 통째로 "한 번도 안 나감"으로 보입니다.** `output/publish/deliveries.json`이
  없으면 원장은 예전 `channels.json`을 읽기 전용으로 이관하는데, 예전 행에는 방 정보가 없어
  **채널의 대표 방 하나**에만 귀속됩니다(`telegram` → 맨틀 한국 커뮤니티). 그래서 **지금까지
  텔레그램으로 나간 모든 과거 항목이 데브방 줄에서는 미발송으로 표시됩니다** — 승인 상태는 그대로라
  줄이 잠기지도 않고, 확인 창 한 번이면 몇 달 전 글이 살아 있는 방으로 나갑니다. `send:channels`의
  first-delivery 가드도 여기서는 도움이 되지 않습니다: **방을 지목하는 것 자체가 확인**이라, 보드의
  방별 `발송`은 설계상 그 가드를 풉니다. 첫 사용 전에 데브방이 실제로 받은 과거 발송을
  `deliveries.json`에 채워 넣거나(방마다
  `{"itemId","type","outletId":"tg-dev","status":"sent","at":"<ISO>","by":"auto"}` 한 행 — `sent`로
  적으면 보드에서도 `발송됨`으로 보이고 다시 누를 수 없습니다), 최소한 **과거 항목의 데브방 줄은
  누르지 말라고 팀에 공지**하세요. PR #80을 이미 거쳐
  `deliveries.json`이 있는 설치본은 해당 없습니다.
- **`output/formatted/overrides.json`을 백업 대상에 넣으세요.** 방별로 갈라 쓴 글(`✎따로`)은 이
  파일에만 있고, 다시 만들어낼 수 없습니다 — 파일이 사라지면 갈라졌던 방이 전부 조용히 그룹 글로
  되돌아가고, 화면에는 오류 하나 뜨지 않습니다. 발송 원장(`output/publish/deliveries.json`)과 같이
  다루면 됩니다.

### Added

- **발송처(outlet) — `type`·`channel`과 나란한 세 번째 축.** 지금까지 "어디로 보냈는가"는 채널로만
  구분됐지만, **맨틀 한국 커뮤니티와 맨틀 한국 데브방은 둘 다 `telegram`**입니다. 이제 방(room)
  아홉 곳이 `src/domain/outlet/models.ts`의 `ALL_OUTLETS` 상수로 정의됩니다 — X 포스트·아티클,
  텔레그램 4곳(커뮤니티·데브방·KOL방·블록체인 커뮤니티방), 오픈카톡 2곳, PR 메일. 각 방은 자동
  (`auto`, 봇/API가 발송)인지 수동(`manual`, 사람이 붙여넣기)인지, 어떤 타입을 기본으로 받는지,
  (자동 텔레그램 방이면) 어떤 chat id 환경변수를 쓰는지를 함께 들고 있습니다. `type`은 **무슨 성격의
  글인지**, `channel`은 **어떤 형식으로 쓰는지**, `outlet`은 **어느 방으로 가는지**입니다.
  `pnpm send:channels`는 채널이 아니라 방마다 한 번씩 발송하고, `--outlets <방 id[,방 id]>`로 방을
  좁힐 수 있습니다. (대시보드 보드 UI는 바로 아래 두 항목 참고.) 설계는
  `docs/superpowers/specs/2026-07-29-outlet-board-design.md`.
- **방 하나만 다른 문구를 쓸 수 있습니다 — 편집하면 갈라지는(fork-on-edit) 방별 override.** 한
  그룹의 문구는 원래 그 문구를 받는 모든 방이 공유하지만, 검수자가 카드가 아니라 **한 방의 줄**을
  고쳐 저장하면 그 방은 독립된 사본(`output/formatted/overrides.json`)을 갖고 `✎따로`로 표시되며
  **따로 승인해야 발송됩니다** — 그룹을 승인해도 이 방은 빠집니다. 이미 승인된 그룹 아래에서 막
  갈라져 나온 방은 **항상 미승인 상태(`rendered`)로 시작합니다** — 고친 글은 아직 그 형태로 검수받지
  않았기 때문입니다. `그룹 글로 되돌리기`를 누르면 override가 삭제되고 그 방은 다시 그룹 글과 그룹
  승인을 따릅니다 — 되돌아가는 유일한 방법입니다(문구가 우연히 그룹과 같아져도 override 자체는
  남아 있는 한 별개의 행입니다). override가 있으면 그것을, 없으면 그룹 렌더링을 돌려주는 순수 함수
  `textFor()` 하나가 이 해석을 담당합니다.
- **2차 검수가 목록에서 발송판(board)으로 바뀌었습니다.** `(itemId, type, channel)` 렌더링을 나열하던
  기존 화면 대신, 카드 하나가 `타입 · 채널` 문구 하나(그리고 승인 상태)를 담고 그 아래에 **그 문구를
  받는 방들**이 한 줄씩 붙습니다. 자동 방은 `발송`(확인 창이 방 이름과 나갈 글을 함께 보여주고,
  누르면 되돌릴 수 없음), 수동 방은 `복사` + `전달함`(사람이 스스로 남기는, 취소 가능한 기록)입니다.
  방이 여러 카드에 걸쳐 있으면(예: 데브방이 공지·해설 둘 다 받음) `n/m`으로 표시되고 줄에 마우스를
  올리면 같은 방의 다른 줄이 함께 밝아집니다. 목적지별 출력(실제로 나갈 바이트/글자 수)과 변환
  원문 대조는 카드 안으로 옮겨 왔고, 별도 상세 화면(`RenderingDetail.tsx`)은 없앴습니다. **편집
  중(저장 전)인 텍스트 단위만 잠깁니다, 카드 전체가 아니라.** 그룹 칸을 고치는 중이면 그룹 자신과
  그 그룹 글을 그대로 쓰는(=갈라지지 않은) 방들의 `발송`·`복사`·`전달함`이 잠기고, 한 방의
  `✎ 따로 쓰기` 칸을 고치는 중이면 **그 방만** 잠깁니다 — 옆방 줄은 그대로 눌립니다. 저장된 옛
  글이 실수로 나가는 것은 여전히 막으면서, 한 방에서의 실수 편집이 상관없는 다른 방까지 얼려
  버리지 않도록 나눈 것입니다(초기 구현은 카드 전체를 잠갔다가, 그러면 잠긴 줄을 풀려는 시도가
  조용히 그 방을 그룹에서 갈라 버리는 부작용이 있어 지금 형태로 좁혔습니다). `[변환 준비]`(체크한
  유형의 워크시트만 써 두는, `convert:prepare`와 동급 — 이 프로젝트에는 Claude API가 없어 실제 변환은 여전히 로컬
  에이전트+`convert:save`의 몫)와 카드별 **`[포맷 다시]`**(그 카드를 `FormatVariants`로 그 자리에서
  다시 렌더링하는 순수 코드라 정말로 실행됨)도 이 화면에서 트리거할 수 있습니다. `포맷 다시`는
  **지금 저장된 문구와 승인 상태를 버립니다** — 확인 창이 무엇이 사라지는지 먼저 밝히고, 되돌릴 수
  없으며, `✎따로`로 갈라진 방의 글은 영향받지 않습니다.
- **수동 방 전달 기록(`전달함`).** 봇이 닿을 수 없는 방(오픈카톡 2곳, 텔레그램 KOL방·블록체인
  커뮤니티방, PR 메일)의 전달 여부도 이제 원장에 남습니다. `MarkDelivery`가 `(아이템, 타입, 방)`에
  `delivered` 행을 쓰고, 잘못 찍었으면 되돌릴 수 있습니다 — 사람이 "보냈다"고 **주장**한 기록이라
  취소 가능합니다. 반면 봇이 실제로 보낸 `sent` 행은 되돌릴 수 없습니다(되돌리면 다음 실행이 살아 있는
  방으로 같은 글을 다시 보냅니다). 자동 방에 `delivered`를 찍는 것도 거부됩니다 — 봇이 그 행을 보고
  "이미 보냈다"고 판단해 조용히 건너뛰기 때문입니다.
- **두 개의 새 변환 타입 — `explainer`(해설)과 `casual`(소통).** 지금까지 텔레그램으로 나가는 글은
  `announcement`(공지) 하나뿐이라, 같은 소식을 데브방과 커뮤니티방에 성격을 달리해 보낼 방법이
  없었습니다. `explainer`는 무슨 일이 있었는지에서 멈추지 않고 **왜 중요하고 어떻게 동작하는지**를
  풀어 쓰는 글(맨틀 한국 데브방 기준), `casual`은 기념일·수상자 발표·초대처럼 커뮤니티가 함께
  반응할 여지가 있는 **가벼운 소식**(맨틀 한국 커뮤니티 기준)입니다. 둘 다 존댓말과 규제 표현
  규칙은 그대로 지키며, 차이는 문체가 아니라 **레지스터**에 있습니다. 각각
  `conversion/explainer.md`·`conversion/casual.md` 지침으로 조종되고, 기본 채널은 `telegram`입니다.
  `ConversionType`을 쓰는 곳(라벨·기본 채널·few-shot 스토어·`doctor` 스티어링 검사·CLI usage 문자열)은
  모두 `ALL_TYPES`에서 파생되므로 별도 배선이 필요 없었습니다 — 기존 불변식 테스트가 누락을 잡습니다.
  `conversion/{kol,pr}.md`도 이번에 스켈레톤(각 7줄)에서 실제 지침으로 채웠습니다.

- **`pnpm config:push` / `pnpm config:pull [--dry-run]` — steering config backup & share via
  Drive.** The git-ignored steering config (`translation/` + `conversion/`, 15 files,
  `*.example.*` skeletons excluded) is the single most valuable, evolving artifact in the
  project — the few-shot corpuses auto-grow on every `translate:save`/`convert:save --approve`
  and `translation/tm.json` grows on `tm:promote` — yet it lived only in one person's working
  tree, with no version control and no backup. `config:push` bundles the config into one JSON
  manifest and uploads it as a timestamped `steering-config-<stamp>.json` snapshot to a
  dedicated Drive folder (auto-provisioned on first run via `GoogleDriveProvisioner`, printing
  `GDRIVE_CONFIG_FOLDER_ID=<id>` to add to `.env`); snapshots accumulate, so any past state stays
  recoverable. `config:pull` finds the newest snapshot and restores it, backing up the current
  local config to `output/archive/steering-<stamp>/` **before** writing anything (a backup
  failure aborts the pull before any file is touched); `--dry-run` reports which files are new/
  modified without writing. Single-maintainer model — push is local→Drive, pull is Drive→local,
  last push wins, no multi-writer merge. Not storage-mode-gated: it only needs Google auth and
  the folder id, same as `google:auth`. See
  `docs/superpowers/specs/2026-07-28-config-sync-design.md`.
- **`pnpm lineage [itemId]` — always-on per-item lineage.** Every save through the four
  content-producing use-cases (`SaveTranslation`, `SaveConversion`, `SaveRendering`,
  `ApproveRendering`) now appends a stage snapshot — best-effort, never blocks the save — to
  `output/lineage/<id>.jsonl`, so a later overwrite (align, refine, approve) never loses the
  previous version. `pnpm lineage <itemId>` prints the item's journey with a per-revision diff
  against the previous entry of the same stage; `pnpm lineage` (no id) lists every item with
  lineage. Wired at every save site (`translate:save`, `convert:save`, `format:save`, and the
  `pnpm serve` dashboard). See `docs/superpowers/specs/2026-07-28-item-lineage-design.md`.
- **`pnpm translate:align [--ids …] [--since …] [--limit …]` — optional TM alignment pass.** A second,
  focused pass over already-drafted-but-unapproved translations (`status === "translated"`), sitting
  between `translate:save` and 1차 검수. For each draft it selects the top **K = 3** `translation/tm.json`
  precedent pairs by shared-anchor overlap with the draft's English `sourceText` (reusing the #52
  anchor engine; anchor-only, a lexical/text-similarity fallback for anchorless drafts is deferred) and
  writes a slim worksheet — 원문 / 현재 번역 / 선례, no glossary or style guide — to
  `output/translations/worksheets/align-<stamp>.md`. A draft with no shared-anchor precedent is skipped,
  not emitted. The local agent revises each draft's phrasing/terminology to match its precedents (a
  correction, not a re-translation) and writes it back with the **existing**
  `translate:save --id <id> --file <korean.txt>` (no `--approve`) — 1차 검수 remains the human gate; no
  new store, port, or `pending.json`. See
  `docs/superpowers/specs/2026-07-28-tm-alignment-pass-design.md`.
- **`pnpm send:channels [--target telegram|x|both] [--ids …]` — §8 channel delivery.** Sends each
  approved channel rendering to its real channel: **Telegram** via the Bot API (`sendMessage`, HTML,
  one message per segment, replies chained), **X** via **Typefully** (v2 draft published now, polled
  for the tweet url). Idempotent — a local ledger `output/publish/channels.json` (row per
  `(itemId, type, channel)`) means a succeeded send never repeats and a failed one retries. Works in
  any storage mode (the senders need only their own tokens); recording to the Sheet `history` tab is
  cloud-only and best-effort. X goes through Typefully only — no official X API, no twitterapi.io
  write (ban-risk on the official account). Config: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`,
  `TYPEFULLY_API_KEY`/`TYPEFULLY_SOCIAL_SET_ID`. Kakao/mail senders and media are out of scope.
  See `docs/superpowers/specs/2026-07-27-channel-delivery-design.md`.
- **`pnpm metrics:record [--month YYYY-MM]` — monthly X performance into the team workbook.** Reads
  the human `KOL list` tab (X rows only, matched by header name), then for the KR official account
  (`REFERENCE_X_HANDLE`, default `0xMantleKR`) and each X KOL fetches follower count + that month's
  authored tweets and writes `followers / posts / views / engagement` to a machine-owned
  `x-performance` tab, upserting one row per `(account, month)`. Raw numbers only — Avg/rates/
  Cost-per-Impression stay as spreadsheet formulas; the human roster/contract/monthly tabs and cost
  columns are never written. Telegram KOLs are left for manual entry (twitterapi.io is X-only). Cloud
  mode + the OAuth `spreadsheets` scope + `GSHEET_ID` required; `skipIfLocal`-gated. Not yet
  live-verified. See `docs/superpowers/specs/2026-07-27-x-performance-tracker-design.md`.
- **Translation memory from @0xMantleKR.** The team's Korean X account publishes translations of
  Mantle_Official's English posts, so the two accounts form real approved EN→KO pairs.
  `pnpm collect:reference` collects @0xMantleKR into an isolated `output/x/reference/` store (never
  the translation queue); `pnpm tm:measure` reports the account's post count and estimated backfill
  cost before a full crawl; `pnpm tm:pair` proposes EN↔KO pairs by shared cashtag/hashtag/mention
  anchors within a temporal window and writes a review worksheet; `pnpm tm:promote` writes the pairs
  a human accepted into `translation/tm.json`. `translate:prepare` now inlines the curated few-shot
  (unchanged) **plus** the TM pairs most relevant to the batch (by same-language anchor overlap),
  replacing the old last-8-by-recency rule. The reference account handle is `REFERENCE_X_HANDLE`
  (default `0xMantleKR`). See `docs/superpowers/specs/2026-07-27-translation-memory-backfill-design.md`.
- **X Article bodies are collected.** `advanced_search` has always returned X Articles inside a
  normal `from:<user>` result, but their tweet `text` is a bare t.co link — a 12,000-character
  report entered the translation queue as one URL, silently. `SourceTweet` now carries an optional
  `article`, `CollectAuthoredContent` fetches each body via `GET /twitter/article?tweet_id=` (one
  call per article not already stored, after thread gap-filling — an article's body is never
  re-fetched once collected), and `XContentSource` renders the Draft.js content
  blocks to markdown. `ContentItem.kind` (`"post"` / `"article"`) is set by `XContentSource` and
  labels the item in the translation worksheet (`### <id> [article]`); `Translation`, what the
  dashboard reads after translation, carries no `kind`, so the post-translation review queue still
  cannot tell them apart. A `divider` block is deliberately **not** rendered as `---`, which `toCanonical` would read
  as a post boundary; `Italic` is flattened. Conversion (§5) and channel formatting (§6) are
  unchanged and still assume post-shaped input — see
  `docs/superpowers/specs/2026-07-23-x-article-support-design.md`.
- **`pnpm impressions:record` (§9b ③).** Reads the Sheet `history` tab, fetches each published X
  post's current view count via the existing `SourceGateway.fetchByIds`
  (`GET /twitter/tweets?tweet_ids=`), and writes it to the reserved `impressions` / `impressionsAt`
  columns (H/I) — the columns `RecordPublish` deliberately leaves empty. `--since <YYYY-MM-DD>`
  narrows to rows published on or after a cutoff; deleted or metric-less tweets are skipped per row.
  X only for v1; not yet live-verified (needs the `spreadsheets` scope, like §9a).
- **`pnpm collect` `--since`/`--limit` flags + coverage ledger.** `--since <3d|12h|1w|ISO>` sets a
  time floor (relative or absolute), overriding the stored watermark; `--limit <n>` caps how many
  threads (by latest tweet) are kept. Either flag makes the run ad-hoc: the watermark
  (`output/x/state.json`) is left untouched, so only flag-less runs advance it. Every run appends a
  coverage record to `output/x/runs.json` — requested/covered range, thread/tweet counts, and a
  `truncated`/`gap` marker when `--limit` or the `MAX_PAGES` (50) pagination cap stops the run short
  of the requested floor. Recommended automation: an hourly `pnpm collect <target> --since 2h` — the
  2h window overlapping the 1h cadence keeps coverage continuous, and upsert dedupes the overlap.
- **Canonical rendering text.** `output/formatted/renderings.json` now stores destination-independent
  canonical text instead of pre-spelled output: bold is `**text**`, links are `[text](url)`, one
  blank line is a paragraph break, and two blank lines — or a lone `---` line, which `toCanonical`
  now also absorbs because the pipeline has always used it as `XContentSource`'s
  `THREAD_TWEET_SEPARATOR` — mark a post boundary (x-channel only; every other destination flattens
  it to a paragraph break). Destination spellings are derived at read time by
  `src/domain/formatting/emitters/`, not stored.
- **Six destinations, one approval per channel.** A channel (`x`/`telegram`/`kakao`/`pr_mail`) is
  still approved once, exactly as before. `x` now reaches two destinations (`x_paste`,
  `x_typefully`), `telegram` reaches two (`telegram_paste`, `telegram_bot`), and `kakao`/`pr_mail`
  reach one each (`kakao_paste`, `pr_mail`) — six in total, never separately approved.
  `GET /api/renderings/:itemId/:type/:channel/emissions` computes only the destinations that
  rendering's channel can reach, on demand.
- **Dashboard: per-destination output with copy buttons.** The 2차 검수 view fetches `emissions` for
  the selected rendering, lets you switch between its destinations, and copies one segment or every
  segment at once — no more assembling the paste-ready text by hand.
- **`--refine` worksheet gained channel constraints, a filtered glossary and a length report.** The
  constraints block is generated from the emitters' own constants (`X_MAX_WEIGHTED`, `TELEGRAM_MAX`,
  `KAKAO_FOLD`) so it cannot drift from the code; the glossary section lists only terms actually
  present in the batch's drafts; and each draft is preceded by a per-segment `length/limit` report
  computed against its channel's primary destination.

### Changed

- **발송이 원문 번역의 승인까지 확인합니다 — 1차 승인 취소가 아래 단계까지 닿습니다.** 지금까지
  `승인 취소`는 번역의 상태만 되돌렸습니다. 그 번역에서 나온 변환본·렌더링·방별 포크는 그대로 남았고,
  `SendChannels`도 `buildBoard`도 번역을 쳐다보지 않았기 때문에 **내보내지 않기로 한 글이 보드에 그대로
  뜨고 버튼 한 번에 나갔습니다.** 이제 방 하나가 나가려면 세 가지가 모두 맞아야 합니다 — 원문이 승인
  상태이고, 이 방의 문구가 승인됐고, **그 승인이 원문의 마지막 승인보다 뒤**여야 합니다. 세 번째 조건이
  `승인 취소 → 원문 수정 → 재승인` 흐름을 잡습니다: 재승인은 *한국어가 맞다*는 뜻이지 *그 한국어에서
  나온 문구가 맞다*는 뜻이 아니므로, 방은 사람이 다시 볼 때까지 잠긴 채로 남습니다.
  **아무것도 지우지 않습니다** — 다듬어 둔 글도, `✎따로` 포크도, 승인 기록도 그대로고 잠기기만 합니다.
  판단은 기록하지 않고 `sendBlock`(`src/domain/send/sendBlock.ts`)이 매번 두 승인 시각을 비교해
  계산하므로, 무효화 패스도 복구 경로도 없고 다시 승인하는 순간 저절로 풀립니다. **화면과 CLI가 같은
  술어를 씁니다** — `isStale`이 `drive:publish`와 `pnpm status` 둘 다를 받치는 것과 같은 이유로, 보드가
  `발송`을 칠하는데 CLI는 거부하는 상태가 생길 수 없습니다.
  포크는 `[포맷 다시]`에도 살아남도록 설계돼 있어서, 원문 수정 뒤 재변환하면 **그룹은 새 글, 포크는 옛
  글**이 되고 둘 다 `승인`으로 보입니다 — `textFor`가 이제 포크 **자신의** 승인 시각을 함께 돌려주므로
  그 방만 잠깁니다. `SendChannels`는 `TranslationStore`를 **필수** 인자로 받습니다(빠뜨리면 검사 없이
  나가므로 optional로 둘 수 없습니다).
- **변환본 승인 단계가 없어졌습니다 — 사람의 검수 관문은 2차 하나입니다.** 예전에는 `format`이
  `status === "approved"`인 변환본만 골라 썼기 때문에, 검수 관문이 세 개(1차 번역 → 변환본 승인 →
  2차 채널)였습니다. 그런데 가운데 관문에는 **화면이 없었습니다** — `pnpm convert:save --approve`로만
  통과할 수 있어서, 대시보드에서 `[변환 준비]` → `[포맷 다시]`를 누른 담당자는 아무 일도 일어나지 않는
  이유를 알 길이 없었습니다. 이제 `format`과 `format --refine`은 변환본의 상태를 보지 않습니다. 포맷은
  기계적인 변환이고 아무것도 밖으로 나가지 않으므로, 같은 글을 2차에서 또 읽게 하는 것 말고는 얻는 게
  없었습니다. **실제 발송 잠금은 그대로입니다** — `send:channels`는 여전히 승인된 *렌더링*만 내보냅니다.
  `convert:save`의 `--approve` 플래그는 제거됐고, 변환본은 항상 `converted`로 저장됩니다.
- **변환 few-shot 승격이 2차 승인 시점으로 옮겨졌습니다.** 예전에는 `convert:save --approve`가
  승격을 겸했는데, 그 시점의 글은 **에이전트가 막 쓴, 아무도 안 읽은 글**입니다. 위 변경으로 `--approve`가
  사라지면 승격 경로도 같이 사라지므로, 이제 `ApproveRendering`(2차 승인)이 그 뒤의 변환본을
  `conversion/few-shot.<type>.json`에 올리고 변환본 상태도 `approved`로 표시합니다 — 파이프라인에서 사람이
  변환된 글을 실제로 읽는 유일한 지점이기 때문입니다. 같은 유형의 채널을 여러 개 승인해도 `itemId` 기준
  upsert라 예시는 하나만 남습니다. 승격되는 예시의 대상 텍스트는 **변환본**이며, 2차에서 채널별로 고친
  내용은 코퍼스에 반영되지 않습니다(승격이 `convert:save`에 있던 시절과 동일).
- **발송 원장이 채널이 아니라 방 단위로 다시 매겨졌습니다 — `output/publish/deliveries.json`.**
  예전 원장 `output/publish/channels.json`은 `(itemId, type, channel)`로 한 행이었는데, 커뮤니티방과
  데브방은 **둘 다 `telegram`**입니다. 그래서 커뮤니티방으로 한 번 나가면 그 행이 채널 전체를 "보냄"으로
  덮어버려, **데브방은 아무것도 받지 못한 채 다음 실행에서 조용히 건너뛰어졌습니다** — 이 재키잉은 그
  버그 때문에 존재합니다. 새 원장은 `(itemId, type, outletId)`로 방마다 한 행을 남깁니다. 예전
  `channels.json`이 있으면 **읽기 전용으로 이관**해 읽습니다(채널 → 그 채널의 대표 방: `telegram` →
  커뮤니티, `x` → 포스트, `kakao` → 블록체인 커뮤니티방, `pr_mail` → PR 메일). 원본 파일은 고치지도
  지우지도 않으므로 되돌려도 잃는 게 없습니다.
- **Sheet `history` 탭도 같은 이유로 방 단위가 됐습니다 — 기존 시트는 한 번 수동 작업이 필요합니다.**
  `history` 행의 식별자가 `(itemId, type, channel)`에서 `(itemId, type, outletId)`로 바뀌었습니다.
  이전에는 두 방의 발송이 **같은 행을 공유해, 나중에 나간 데브방이 커뮤니티방의 `postId`와 `t.me`
  링크를 덮어썼습니다** — 텔레그램으로 보낼 때마다 한 방의 기록이 사라졌습니다. 방 id는 **새 J 컬럼
  (`outletId`)** 에 들어갑니다.
  - **기존 시트에 해야 할 일:** `history` 탭의 **J1 셀에 `outletId`** 라고 직접 적어주세요.
    헤더는 탭이 비어 있을 때만 자동으로 쓰이므로(`ensureHistoryTab`), 이미 쓰던 시트에는 라벨이
    생기지 않습니다. 값 자체는 라벨이 없어도 J 컬럼에 정상적으로 쌓입니다 — 라벨은 사람이 읽기 위한
    것입니다.
  - **임프레션 컬럼 H·I는 건드리지 않았습니다.** `outletId`를 `channel` 옆이 아니라 맨 뒤(J)에 둔 이유가
    이것입니다 — 중간에 컬럼을 끼우면 아직 손대지 않은 시트에서 기존 행의 임프레션 값이 한 칸씩
    밀려 발송 값과 섞입니다. `impressions:record`는 그대로 H·I만 씁니다.
  - 방 칸이 빈 **예전 행은 그대로 남습니다.** 업그레이드 후 같은 아이템을 다시 보내면 예전 행을 고치는
    대신 방별 새 행이 추가됩니다.
- **`TELEGRAM_CHAT_ID`는 방별 `TELEGRAM_CHAT_ID_COMMUNITY`/`TELEGRAM_CHAT_ID_DEV`로 대체됐습니다(deprecated).**
  발송이 방 단위가 되면서 방마다 chat id가 필요합니다. `git pull` 직후 발송이 멈추지 않도록 폴백을
  남겼습니다 — `TELEGRAM_CHAT_ID_COMMUNITY`가 비어 있으면 **맨틀 한국 커뮤니티 한 방에만** 레거시
  `TELEGRAM_CHAT_ID`가 쓰이고 경고가 출력됩니다(데브방은 폴백 대상이 아닙니다). 값이 비어 있는 방으로는
  발송하지 않으며, 그 방은 `failed`가 아니라 요약 줄의 `· 미설정 N (TELEGRAM_CHAT_ID_DEV)`로 따로
  표시됩니다 — 레거시 설정 그대로 쓰는 설치본은 고장난 게 아니기 때문입니다. 설정 방법은
  [`docs/ko/setup/channels.md`](docs/ko/setup/channels.md) T-3.
- **한 번도 발송한 적 없는 방에는 백로그를 자동으로 내보내지 않습니다.** `renderings.json`은 지워지지
  않고 승인 상태도 그대로라, 방을 새로 설정하면 **그동안 승인된 렌더링 전부**가 그 방으로 미발송
  상태입니다. 그대로 두면 다음 `pnpm send:channels` 한 번에 살아 있는 방으로 백로그가 통째로
  쏟아집니다. 이제 원장이 빈 방에 2건 이상이 대기 중이면 방 이름과 건수를 경고로 남기고 **보류**하며,
  `--outlets <방 id>`로 그 방을 직접 지정해야 나갑니다.
- **`pr-mail`은 수동(`manual`) 방이 됐습니다.** 메일 발송기가 아직 없어 `send:channels`가 닿을 수 없는데
  `auto`라는 이유로 `전달함` 체크까지 거부돼, **보낼 수도 없고 보냈다고 기록할 수도 없는** 방이었습니다.
  메일 발송기가 생기면 다시 `auto`로 돌립니다.
- **`history` auto-creates its tab, so one workbook can hold every machine tab.** `RecordPublish`
  (behind `history:record` and `send:channels`) now ensures the `history` tab + header before
  writing, mirroring how `metrics:record` handles `x-performance`. You can point `GSHEET_ID` at your
  existing team workbook and skip `sheet:init` — a `send:channels` run in cloud mode no longer logs
  `history record failed: HTTP 400` just because the sheet was created by hand or by `metrics:record`
  rather than by `sheet:init`. (`targets` for `targets:list` is still the one tab you fill by hand.)
- **`--x-bold` removed.** Unicode "bold" characters are skipped entirely by screen readers, are not
  matched by X search, and cost double the weighted length of a plain character. `pnpm format
  --x-bold unicode` and `--x-bold=unicode` now fail immediately, naming the reason. Write
  `**bold**` in canonical text instead — each destination decides how to spell it.

### Fixed

- **Collection now expands `t.co` shortlinks instead of storing the redirect.** `normalizeTweet`
  replaces each `t.co` link in a tweet's `text` with its real `expanded_url` (from `entities.urls`)
  and removes a tweet's own photo/video `t.co` self-links — that media stays on
  `SourceTweet.media`, it was never a link. Translations and Telegram/X delivery now carry the real
  URL instead of `t.co`. See `docs/superpowers/specs/2026-07-28-tco-url-expansion-design.md`.
- **Outbound `fetch` survives a broken IPv6 route (common on WSL2/Docker).** Node's default
  Happy-Eyeballs family autoselection raced a resolvable-but-unroutable IPv6 address against IPv4 and
  returned `ETIMEDOUT`, so a command could die with a bare `fetch failed` even though `curl` reached
  the same host — hit while live-verifying `send:channels` against api.telegram.org. Every CLI now
  disables family autoselection at startup (`src/cli/preferIpv4.ts`, equivalent to
  `--no-network-family-autoselection`).
- **A re-collect no longer reverts a stored X Article body to a bare link.** Neither
  `GET /twitter/tweet/thread_context` (gap-filling a missing thread root) nor a routine
  `advanced_search` re-normalize ever carries `article.blocks` — only `GET /twitter/article`, via
  `fillArticleBodies`, does. Before this fix, `LocalJsonStore.upsert` let the incoming
  (blockless-or-article-less) tweet win outright, so any collect run after the day an article was
  first fetched silently dropped its stored body back to a link. `LocalJsonStore.mergeTweet` now
  carries a stored article forward whenever the incoming tweet's own article is missing or has no
  blocks.
- **X length is now counted by weight, matching X's real limit — a bug fix, not a feature.**
  `weightedLength()` replaces a code-point count that compared `[...text].length` against 280. X
  actually counts by weight (`twitter-text` v3 config): a Hangul syllable costs 2, so a pure-Korean
  post maxes out at **140 characters**, and any URL counts as exactly 23 regardless of its real
  length. The old check silently passed over-limit Korean posts between 141 and 280 characters with
  no warning at all.

## [0.2.0] - 2026-07-21

### Upgrading — action required for existing installs

#### `git pull` deletes your steering config — restore it before running anything

Untracking `translation/` and `conversion/` means the merge commit **deletes those ten files from
the index**. They were tracked before, so `git pull` removes them from your working tree too. Your
real glossary, style guide, locale and few-shot corpora disappear. This bites once, on the pull that
brings this release in.

**Do not run `pnpm config:init` to recover** — that writes generic skeletons from `*.example.*` and
would leave you with an empty glossary and no few-shot examples. Restore the real content from the
commit before this release instead:

```bash
# <pre-release> = the last commit before this release landed on main
for f in $(git ls-tree -r --name-only <pre-release> translation conversion | grep -v '\.example\.'); do
  git show "<pre-release>:$f" > "$f"
done
pnpm doctor   # "Steering config … ok" once they are back
```

Verify before continuing: `translation/glossary.json` should hold your real terms, and
`translation/few-shot.json` / `conversion/few-shot.x.json` your approved examples — not `[]`.

From then on these files are yours alone and git will not touch them again. Back them up somewhere
outside the repo; nothing in this project protects them any more, by design.

#### Set the storage mode

`HERALD_STORAGE_MODE` is now **required** and is never inferred. A fresh clone gets it from
`.env.example`, but an existing `.env` predates it, so the cloud commands (`drive:publish`,
`drive:init`, `sheet:init`, `targets:list`, `history:record`) will fail until you add one line:

```bash
# append to your existing .env — "cloud" if Google/Lark Drive is your record of truth
HERALD_STORAGE_MODE=cloud
```

Defaulting it was considered and rejected. Defaulting to `local` would silently misroute a cloud
operator's work: `drive:publish` still runs and still reports success, but the documents land in
`output/publish/local/` instead of Drive — guessing wrong sends published work to the wrong place
either way, which is worse than failing loudly once.

### Added

- **`.env.example` reorganised, and every variable tagged.** It is now ordered by when you
  actually need a value — always required, then per collection source, then cloud-mode only, then
  local tools — and each entry is marked `[REQUIRED]` (with the command that needs it),
  `[OPTIONAL]` (with its default) or `[PICK ONE]`. `HERALD_STORAGE_MODE` documents the intended
  path explicitly: **start on `local`, promote to `cloud` when setup is finished** — local mode is
  not a fallback, it runs the whole pipeline, and it makes you the owner of the git-ignored
  `output/` tree. Two variables the code reads were missing entirely: `GOOGLE_OAUTH_SCOPE`
  (`google:auth` reads it; it appeared only inside a comment, so copying the file gave you no slot
  for it) and `PORT` (`serve`). A stale `docs/guides/…` path was corrected — that sweep had covered
  `*.md` and `*.ts` but not `.env.example`.
  `tests/config/envExample.test.ts` now keeps this from drifting again: it fails when `src/` reads
  an undocumented variable, when the file lists one nothing reads, or when a variable is untagged.

- **`docs/ko/setup/steering.md`** — how to actually obtain the real `translation/`+`conversion/`
  config. It is not in git, and a new team member had no documented way to get it: `team-runbook.md`
  claimed these files were "what `pnpm config:init` creates", which is false — `config:init` writes
  empty skeletons. Following that sentence produced translations with none of the team's
  terminology, and `pnpm doctor` reported the setup as fine. Corrected, with a verification step
  (`pnpm glossary` must not print `0 entries`) and the recovery procedure for losing them.

- **`docs/ko/review.md`** — a guide for the people who read, edit and approve the Korean copy but
  never open a terminal. Every existing Korean document assumed a shell in its opening paragraph,
  yet second-round review (§7) is dashboard-only, so that reader had no page at all. It covers the
  two review modes, the fact that `승인 ✓` stays disabled until you press `저장`, and where the
  per-channel review checklists live — `conversion/checklist.*.md`, which sit in the gitignored
  steering folder and were effectively undiscoverable.
- **`docs/ko/README.md`** — a role-based entry point ("what should I read?") for the Korean docs.

- **`announcement` conversion type** — community announcements (Telegram 공지방 + KakaoTalk) are now
  their own conversion type, steered by `conversion/announcement.md`. They were previously produced
  by the `kol` type, which is a different kind of writing: an announcement and a request sent to a
  KOL room travel over the same Telegram transport but follow opposite CTA rules (X and KOL copy
  avoid `~하세요` imperatives for regulatory reasons; an announcement uses them). Conversion type
  answers *what is written*, `Channel` answers *where it goes* — the two axes are deliberately not
  1:1, and `DEFAULT_CHANNELS_BY_TYPE` now reflects that: `announcement` fans out to
  `telegram`+`kakao`, and `kakao` moved off `x` (a KakaoTalk post reads like an announcement, not
  like a tweet). Existing `x` variants are unaffected; no stored data needed migrating.

- **`pnpm status`** — a pipeline-visibility command: reads the local `output/` stores and prints a
  per-stage funnel (collected → translated → converted → rendered → published, with approved
  sub-counts) so you can see how far data has flowed. Offline.
- **`pnpm doctor`** — a setup-diagnosis command: offline config checks per integration
  (twitterapi / Lark / Google Drive+Sheets), plus `--live` to mint tokens read-only and report the
  granted OAuth scopes (catches e.g. a Google token missing the `spreadsheets` scope, or Lark auth).
  Exits non-zero if any check fails.
- **Content shaping (F)** — §5 item conversion (`convert:prepare` / `convert:save`) rewrites an
  approved translation into X / KOL / PR variants with per-type steering config in `conversion/`
  and a per-type few-shot flywheel; §6 channel formatting (`format` / `format:save`) renders a
  variant for X / Telegram / KakaoTalk / PR-mail with deterministic formatters and an optional
  agent refinement pass.
- **Second review (§7)** — the local dashboard gains a **2차 검수** mode to list/filter, edit, and
  approve Module F channel renderings before posting. `ChannelRendering` gains a `rendered`/`approved`
  status; new `ApproveRendering` use-case and `/api/renderings` routes; approved text is copy-ready.
- **Google Sheet data hub (§9a)** — a team-editable Sheet as the automation's data hub via the direct
  Sheets v4 REST API (reusing the Google `TokenSource`): `sheet:init` provisions the `targets`/`history`
  tabs, `targets:list` reads the distribution targets (①), and `history:record` upserts publish rows (②).
  ③ impressions and §8 wiring are follow-ups.
- **`pnpm lark:chats`** — lists the chats the Lark bot is a member of (id + name), so you can find a
  chat id for `LARK_CHAT_IDS` without a raw API call.
- **`pnpm lark:send --chat <id> --text <…>`** — sends a text message to a Lark chat (defaults the
  chat to the first `LARK_CHAT_IDS` entry). The foundation for §10 (Lark bot); pipeline-content
  wiring is a follow-up.
- **Explicit storage mode** — `HERALD_STORAGE_MODE=local|cloud` decides whether Drive is the record
  of truth or everything stays local. `local` needs no cloud credentials — the post-collection
  stages (translate / convert / format) never call an external API either way, and `local` also
  skips `drive:init`, `sheet:init`, `targets:list` and `history:record` with a clear message
  (`drive:publish` is not one of them — in `local` mode it targets the filesystem instead of
  skipping); collection still needs a key for whichever source you use (`TWITTERAPI_IO_KEY` for X,
  the Lark app credentials for Lark), independent of storage mode. `cloud` behaves as before.
  Storage mode is never inferred.
- **Sync ledger** — `output/publish/state.json` now records which drive, remote id, URL, filename,
  content hash and timestamp for every upload (legacy key sets migrate on read). `pnpm status`
  reports published / unsynced / stale counts, so an item edited after publishing is visible.
- **`pnpm archive` / `pnpm clean`** — retention for worksheets and superseded batches under
  `output/archive/<date>/`; `clean` removes archives older than 30 days (`--older-than`) and temp
  files stranded by interrupted writes, listing them unless `--yes` is passed.
- **`pnpm config:init`** — creates the steering config from the tracked `*.example.*` skeletons.
- **Documentation set** — `docs/ko/{capabilities,quickstart,team-runbook,artifacts}.md` covering what
  the project does, how external and internal users run it, and where every artifact is stored;
  `docs/README.md` records the documentation rules.
- **`local` publish target** — `pnpm drive:publish` now writes the review/approved markdown documents to
  `output/publish/local/{review,approved}/` instead of skipping publication in
  `HERALD_STORAGE_MODE=local`. `--target` accepts a comma-separated list (`google,local`); `both`
  remains an alias for `google,lark`. The dashboard publishes in local mode too, and picks its
  target options from the new `GET /api/config`.
- **`LocalFileUploader.update`** — when a re-approval changes `publishFileName` (it embeds
  `approvedAt`'s date), the local uploader writes the new file and then deletes the old one, so a
  re-approved item ends up as exactly one document on disk — mirroring the Drive PATCH that
  updates content in place while preserving a file id.

### Changed

- **`pnpm doctor` no longer hard-fails in cloud mode over optional credentials.** Only the core
  cloud publish path — Google auth + Google Drive — is required in cloud mode (plus the storage mode
  and steering config, required in every mode). twitterapi.io and the Lark app are source
  credentials (needed only if you collect from that source), Lark Drive is an opt-in publish target,
  and the Google Sheet (§9a) is an optional data hub, so their absence is now a `warn` in both modes,
  never a `fail`. Previously a valid Google-Drive-plus-X setup exited 1 in cloud mode over the Lark
  and Sheet credentials it does not use. New `optionalCheck` helper in `src/doctor/checks.ts`.

- **`docs/guides/` moved to `docs/ko/setup/`.** `docs/` was splitting by two axes at the same
  level — language (`en/`, `ko/`) beside audience (`architecture/`, `guides/`, `superpowers/`) —
  so Korean setup procedures sat outside `ko/` and English design docs sat outside `en/`. The rule
  is now: only user-facing docs carry a language, so only they nest under a language folder;
  `architecture/` (English by rule) and `superpowers/` (an archive) stay at the top level. Files
  were renamed to drop the redundant suffix (`google-drive-setup-guide.md` → `setup/google-drive.md`).

- **The steering config now carries the KR team's real guidelines.** `translation/style-guide.md`
  (46 → 200 lines), `glossary.json` (36 → 78 terms), `locale.json`, `few-shot.json` and
  `conversion/x.md` (8 → 156 lines) were migrated from the team's Lark documents, which stay the
  canonical source — each file's `> 출처:` line links back to it. Review checklists live beside
  them as `conversion/checklist.<type>.md` and are deliberately **not** loaded into any prompt.
  Note `promptAssembler.renderLocale()` renders only the five fixed `Locale` fields; extra keys in
  `locale.json` load but never reach the prompt.

- **`pnpm doctor` checks a guide for every conversion type**, not just `conversion/x.md`.
  `loadTypeGuide()` falls back to an empty string when the file is missing, so a type without its
  `.md` used to convert with no steering at all and no warning.

- **`pnpm doctor` now looks at steering *content*, not just presence.** A `pnpm config:init` tree
  passed the check while steering nothing — an empty glossary and guides identical to their
  `*.example.*` skeletons still counted as ✓. It now reports `⚠ present but empty` and names the
  files. The missing-file hint also stopped pointing everyone at `config:init`, which is the wrong
  recovery for someone whose real files disappeared; it now distinguishes a fresh install from a
  loss and links `docs/ko/setup/steering.md`.

- **The real steering config left git.** `translation/` and `conversion/` now track only
  `*.example.*` skeletons; the actual glossary, style guide and few-shot corpus are local. Routine
  approvals no longer dirty the working tree.
- **`pnpm status` warns about unsynced/stale work in `local` mode exactly as in `cloud` mode.** The
  previous `(local mode — publishing disabled)` line hid a real backlog now that local publishing
  exists.
- **`skipIfLocal()` now gates four commands, not five.** `drive:publish` left the list — in local
  mode it targets the filesystem instead of skipping.
- **Requesting a cloud target in `local` mode now fails instead of skipping.**
  `pnpm drive:publish --target google` (or `lark`, or `both`) under `HERALD_STORAGE_MODE=local`
  throws and exits `1`; previously it matched the blanket local-mode skip and exited `0`, so a
  wrapper script that checked the exit code alone could not tell "skipped" from "uploaded".

### Fixed

- **A stale publish can now be repaired.** `pnpm drive:publish` re-uploads an item whose content
  changed after it was published, updating the file in place — for Google Drive its id and share
  link (and any link already recorded in the Sheet `history` tab) are preserved; for the `local`
  target `LocalFileUploader.update` does the equivalent. Previously `pnpm status` could report an
  item as `stale` with no way to resolve it. Google Drive and `local` only; Lark Drive has no
  content-replace endpoint, so a stale item there is reported as a failure. Items published before
  the sync ledger existed carry no content hash and are never re-uploaded.
- **Lark collection (B)** — incremental re-runs no longer re-collect the boundary message. Lark's
  `start_time` filter floors to the second and is inclusive, so the API re-returned the message at
  the exact watermark instant on every run (reported as `collected 1` with no new data). The gateway
  now drops anything at or before the ms-precise watermark client-side, mirroring the X collector.
  Verified live: the Lark bot's `im:message.group_msg` scope is approved, `collect-lark` reads group
  messages, and a no-new-data re-run now reports `collected 0`.
- **Artifact paths are anchored to the repo root**, not the process CWD. Running a command from a
  subdirectory silently created a second `output/` tree; all 36 path literals now come from
  `src/paths.ts`.
- **`prepare` no longer strands an unsaved batch.** `translate:prepare`, `convert:prepare` and
  `format --refine` archive the previous `pending.json` before replacing it and write it atomically
  like every other store; `translate:save` and `format:save` fall back to an already-saved item
  instead of throwing.

## [0.1.0] - 2026-07-15

Initial release: the end-to-end Mantle KR content pipeline
(collect → translate → review → publish), subsystems A–E, run locally per operator.

### Added

- **X data collection (A)** — Incremental tweet collection via twitterapi.io with a
  keyed per-handle watermark, soft-mark deletion, and conversationId thread grouping.
  Collect stops client-side at the watermark and caps pagination.
- **Lark data collection (B)** — Message collection over the Lark IM API on shared
  HTTP/store infrastructure. (Code + tests; live verification pending Lark app approval.)
- **Korean translation (C)** — Source-agnostic `ContentItem` model and an agent-assisted
  translation flow with living steering config in `translation/` (glossary, style guide,
  locale, few-shot). `translate:prepare` → agent fills the worksheet →
  `translate:save [--approve]`, with approved translations feeding the few-shot flywheel.
- **Drive upload (D)** — Headless Markdown publishing to Google Drive and Lark Drive:
  review docs (source + Korean) for translated items, Korean-only for approved.
  Descriptive filenames `<date>-<slug>-<id>.md`, per-drive idempotency, and failure
  isolation. `drive:init` provisions and shares the folders.
- **Review dashboard (E)** — Local web tool (`build:web` + `serve` → localhost) with a
  `node:http` JSON API over the existing use-cases and a React + Vite + Tailwind v4
  frontend to list, filter, edit, approve, and publish translations.
- **Google auth** — Selectable OAuth user-delegation and service-account strategies
  behind a shared `TokenSource`, plus `google:auth` for one-time OAuth consent.

### Changed

- Renamed `data/` → `translation/` to better describe the translation steering config.
- Reorganized `output/` into per-stage subfolders (`x`, `lark`, `translations`, `publish`).
- `drive:publish` defaults to `--target google` (Lark is opt-in).

### Fixed

- Collect stops at the watermark instead of crawling the full account history
  (advanced_search ignores `since_time`), cutting a run from ~12 min to ~2 s.
- Collect no longer aborts on a tweet missing `author.userName`.
- Google Drive uploads use OAuth for personal Gmail accounts, working around service
  accounts having no storage quota (403 `storageQuotaExceeded`).
- `google:auth` CLI no longer crashes on a late loopback request after the server begins
  closing (`server.address()` returned `null`).
- Dashboard server returns 500 safely instead of crashing when a response fails to serialize.

[Unreleased]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kyle-park-io/mantle-kr-herald/releases/tag/v0.1.0
