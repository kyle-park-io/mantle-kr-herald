/** The original tweet URL for an `x:<id>` item, else null (lark items have no public URL). */
export const itemUrl = (itemId: string): string | null =>
  itemId.startsWith("x:") ? `https://x.com/i/status/${itemId.slice(2)}` : null;

/** An ISO date → a compact `[YYMMDD]` prefix (the original post date); "" when absent. */
export const datePrefix = (iso?: string): string =>
  iso && iso.length >= 10 ? `[${iso.slice(2, 10).replace(/-/g, "")}]` : "";

/**
 * An ISO (UTC) instant → `2026-07-31 14:39 KST`, or `undefined` when there is nothing to show.
 *
 * Pinned to `Asia/Seoul`, NOT the viewer's zone — which is the one thing that makes the `KST` label
 * honest. This board is shared with a team and its timestamps get read back against x.com, so one
 * instant has to render identically for everyone looking at it.
 *
 * Deliberately different from `stamp` in `OutletCard.tsx`, which formats in the *viewer's* zone and
 * carries no label. Two conventions in one app is not ideal, but unifying them changes an existing
 * display, so that is its own decision rather than a side effect of adding this.
 *
 * Slicing the ISO string instead — the obvious shortcut — prints UTC as if it were Seoul: nine
 * hours off, and a whole calendar day off for anything published after 15:00 UTC.
 */
export const kstStamp = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const at = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")} KST`;
};

/**
 * `07. 29. 06:20` in Korea time — the compact form for a chip label ("발송됨", "전달함 ☑", "예약됨").
 *
 * Unlabelled on purpose: those chips sit in narrow rows where a trailing ` KST` would wrap. The
 * zone is stated in `kstStampFull`, which is the tooltip on the very same element, so the label
 * exists exactly where there is room for it.
 *
 * Returns `""` rather than `undefined` because callers interpolate it straight into a label.
 */
export const kstStampShort = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
};

/** The same instant spelled out, with the zone named — the row is narrow, the tooltip is not.
 *  Returns `undefined` so callers can keep their `?? "이미"` fallbacks. */
export const kstStampFull = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : `${d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST`;
};

// Mirrors ALL_TRANSLATION_STATUSES in src/domain/translation/models.ts — same reason as ALL_TYPES
// below (the frontend cannot import the domain), and `tests/web/typeMirror.test.ts` fails if this
// drifts. `posted` is the reconcile-retired state (Task 2): a translation reconcile matched against
// a live @0xMantleKR post and marked done outside this dashboard — never `published`, which already
// means "uploaded to Drive" elsewhere in this repo.
export const ALL_TRANSLATION_STATUSES = ["translated", "approved", "posted"] as const;
export type TranslationStatus = (typeof ALL_TRANSLATION_STATUSES)[number];

export interface Translation {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  status: TranslationStatus;
  translatedAt: string;
  approvedAt?: string;
  kind?: "post" | "article";
  /**
   * Source post date (ISO), for the `[YYMMDD]` prefix — deliberately NOT named `postedAt`.
   * `src/domain/translation/models.ts`'s `Translation.postedAt` means something else entirely (Task
   * 2's reconcile-match timestamp), and `GET /api/translations` is not the only route that answers
   * with a translation shape: `/approve`, `/unapprove`, and `/unretire` (`apiHandlers.ts`) return the
   * raw domain row via `findById`, never routed through `attachKind`. A field literally named
   * `postedAt` here would type-check against both — a raw domain row cast to this `Translation` type
   * would silently carry the reconcile-match time under a field this interface documents as "source
   * post date", with no compiler error, only a wrong `[YYMMDD]` prefix the moment some future caller
   * reads it (e.g. an optimistic UI update off one of those three routes' response, which today every
   * `App.tsx` handler discards in favor of a full `refresh()`). Naming it `sourcePostedAt` instead
   * means those three raw-domain responses simply lack this field (`undefined`, not wrong), and
   * mirrors `src/adapters/web/attachKind.ts`'s `ApiTranslation.sourcePostedAt`, which this is a
   * hand-kept copy of.
   */
  sourcePostedAt?: string;
  /** The live X post a reconcile match found this translation already published as, by hand. */
  postedUrl?: string;
  /**
   * When that live post actually went out — the root tweet's `createdAt`, carried straight through
   * from `Translation.postedAt` in `src/domain/translation/models.ts`. Already on the wire
   * (`attachKind` spreads the domain row); this declaration is what lets the dashboard read it.
   *
   * Not `sourcePostedAt` above, which is the *English* source post's date and drives the `[YYMMDD]`
   * prefix. The two differ by however long the translation sat in review — which is exactly the
   * interval a reviewer looking at a row nobody approved is trying to see.
   */
  postedAt?: string;
  /**
   * The Korean copy @0xMantleKR actually published, as read off the account by `x:reconcile` — not
   * what we produced, which is `koreanText`. Already on the wire (`attachKind` spreads the domain
   * row); this declaration is what lets the dashboard read it.
   *
   * Absent until a reconcile run captures it: only a translation reconcile matched to a live post
   * has one, capture is fill-only, and a post that has aged out of the run's `--since` window is
   * never fetched. So a `posted` item without this field is ordinary, not an error.
   */
  publishedText?: string;
}
export interface PublishResult {
  uploaded: number;
  updated: number;
  failed: number;
  failures: { key: string; error: string }[];
  byDrive: Record<string, number>;
}

// Mirrors src/domain/{conversion,formatting}/models.ts. The frontend cannot import the domain
// (separate tsconfig + Vite root), so this is a hand-kept copy — `tests/web/typeMirror.test.ts`
// fails if it drifts. Derive the unions from the arrays so every UI list stays exhaustive:
// a hardcoded `<option>` list is invisible to the compiler and silently loses a new type.
export const ALL_TYPES = ["x", "announcement", "explainer", "casual", "kol", "pr"] as const;
export const ALL_CHANNELS = ["x", "telegram", "kakao", "pr_mail"] as const;
export type ConversionType = (typeof ALL_TYPES)[number];
export type Channel = (typeof ALL_CHANNELS)[number];

/** Korean display label per type — mirrors `typeLabel()` in the domain. */
export const TYPE_LABEL: Record<ConversionType, string> = {
  x: "X",
  announcement: "공지",
  explainer: "해설",
  casual: "소통",
  kol: "KOL",
  pr: "PR",
};

export interface Rendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
  refined: boolean;
  createdAt: string;
  status: "rendered" | "approved";
  approvedAt?: string;
  convertedText: string; // joined source context (variant convertedText)
  // Joined from the source item so the 2차 list and board header read like 1차's.
  kind?: "post" | "article";
  postedAt?: string; // source post date (ISO), for the [YYMMDD] prefix
}

/** Stable identity key for a rendering: (itemId, type, channel). */
export const renderingKey = (r: Pick<Rendering, "itemId" | "type" | "channel">) =>
  `${r.itemId}:${r.type}:${r.channel}`;

// Mirrors src/storage/mode.ts — keep in sync.
export type StorageMode = "local" | "cloud";

export interface IntegrationStatus {
  key: string;
  label: string;
  group: "collect" | "publish" | "send" | "data";
  configured: boolean;
}

/** A header link to a team workbook, named after the workbook itself. */
export interface SheetLink {
  url: string;
  title: string;
}

/**
 * Mirrors `StageTally`/`FunnelCounts` in `src/status/pipeline.ts` — pinned by
 * `tests/web/typeMirror.test.ts`, which exists because both typechecks stayed green when these two
 * declarations last disagreed.
 *
 * Two counts because past the translation stage a row stops meaning an item: a variant is keyed
 * `(itemId, type)`, a rendering `(itemId, type, channel)`, a publish-ledger row
 * `(itemId, status, target)`. Showing only `rows` made 변환 10 → 렌더 13 look like the pipeline
 * gaining work between two stages when three items had simply fanned out twice.
 */
export interface StageTally {
  items: number;
  rows: number;
}

export interface FunnelCounts {
  collected: StageTally;
  translated: StageTally;
  converted: StageTally;
  rendered: StageTally;
  published: StageTally;
}

export interface AppStatus {
  storageMode: StorageMode;
  availableTargets: ("local" | "google" | "lark")[];
  funnel: FunnelCounts;
  sync: { synced: number; needsRepublish: number; unpublished: number };
  integrations: IntegrationStatus[];
  /** Header links to the team workbooks — absent when the id is not configured. */
  sheetLinks: { data?: SheetLink; qa?: SheetLink };
  /**
   * The attached database's stated `HERALD_DB_ENV` — mirrors the same field on the server's
   * `StatusView` (`apiHandlers.ts`). Drives `EnvironmentBanner`'s persistent warning when this is
   * not `"production"`. Optional here (unlike the server, where it is required) only so an older
   * cached response or a test fixture that predates this field renders no banner rather than a
   * crash — a real response always carries it.
   */
  dbEnv?: "production" | "development";
  /**
   * Whether `POST /api/outlets/:id/:type/:outletId/send` is actually open — mirrors the server's
   * `StatusView.sendsEnabled`. Drives `EnvironmentBanner`'s other persistent notice. Same optionality
   * note as `dbEnv` above.
   */
  sendsEnabled?: boolean;
  /**
   * Whether `POST /api/items/:id/convert-prepare` exists on this deployment — mirrors the server's
   * `StatusView.conversionEnabled`. Drives whether `OutletBoard` offers [변환 준비] at all. Same
   * optionality note as `dbEnv` above; `OutletBoard` treats an absent value as "available", which is
   * what every deployment that predates this field was.
   */
  conversionEnabled?: boolean;
}

export interface PublishStateRow {
  itemId: string;
  status: string;
  target: string;
  url?: string;
  remoteId?: string;
  fileName?: string;
  folderUrl?: string;
  fileUrl?: string;
  synced?: boolean; // false = published but outdated (needs republish)
}

// Mirrors src/domain/formatting/emitters/types.ts — keep in sync.
export type Destination =
  | "x_paste" | "x_typefully"
  | "telegram_paste" | "telegram_bot"
  | "kakao_paste" | "pr_mail";

export interface EmitSegment {
  text: string;
  label?: string;
  length: number;
  limit: number;
  overLimit: boolean;
}
export interface EmitResult {
  segments: EmitSegment[];
  warnings: string[];
}
export type Emissions = Partial<Record<Destination, EmitResult>>;

export const DESTINATION_LABEL: Record<Destination, string> = {
  x_paste: "X 붙여넣기",
  x_typefully: "Typefully",
  telegram_paste: "텔레그램",
  telegram_bot: "텔레그램 봇",
  kakao_paste: "카카오",
  pr_mail: "메일",
};

/** Korean display label per channel — dashboard-only, the same role DESTINATION_LABEL plays. */
export const CHANNEL_LABEL: Record<Channel, string> = {
  x: "X",
  telegram: "텔레그램",
  kakao: "카카오",
  pr_mail: "메일",
};

/**
 * The `_paste` spelling of each channel — mirrors DESTINATIONS_BY_CHANNEL's paste entry. [복사]
 * must hand over this text, not the canonical one: KakaoTalk and the Telegram composer parse no
 * markup, so pasting the canonical `**굵게**` / `[label](url)` puts the markers in a live room.
 */
export const PASTE_DESTINATION: Record<Channel, Destination> = {
  x: "x_paste",
  telegram: "telegram_paste",
  kakao: "kakao_paste",
  pr_mail: "pr_mail",
};

// Mirrors ALL_OUTLETS in src/domain/outlet/models.ts — the delivery rooms. Same reason as
// ALL_TYPES above (the frontend cannot import the domain), and `tests/web/typeMirror.test.ts`
// fails if either record drifts: a missing label would show a reviewer a raw `tg-dev` id, and a
// wrong delivery mode would offer [발송] on a room no bot can post to.
export const OUTLET_LABEL: Record<string, string> = {
  "x-post": "@0xMantleKR 포스트",
  "x-article": "@0xMantleKR 아티클",
  "tg-community": "맨틀 한국 커뮤니티",
  "tg-dev": "맨틀 한국 데브방",
  "tg-kol": "텔레그램 KOL방",
  "tg-blockchain": "텔레그램 블록체인 커뮤니티방",
  "kakao-kol": "오픈카톡 KOL방",
  "kakao-blockchain": "오픈카톡 블록체인 커뮤니티방",
  "pr-mail": "PR 메일",
};

/** `auto` = a bot posts it ([발송]); `manual` = a human pastes it and ticks 전달함. */
export const OUTLET_DELIVERY: Record<string, "auto" | "manual"> = {
  "x-post": "auto",
  "x-article": "auto",
  "tg-community": "auto",
  "tg-dev": "auto",
  "tg-kol": "manual",
  "tg-blockchain": "manual",
  "kakao-kol": "manual",
  "kakao-blockchain": "manual",
  "pr-mail": "manual",
};

/** A room the server rowed but this build has no label for still has to render as something. */
export const outletLabel = (id: string): string => OUTLET_LABEL[id] ?? id;

// Mirrors src/adapters/web/board.ts — the GET /api/items/:id/board payload.

/** One room under a group card: what it will send, and whether it already went out. */
/**
 * Why a room may not send. Mirrors `src/domain/send/sendBlock.ts` — the server computes it with the
 * same predicate `SendChannels` enforces, so a row that shows no block is a row that will send.
 */
export type SendBlock = "source-missing" | "source-unapproved" | "unapproved" | "source-changed";

/** What the reviewer is told, keyed by block. Mirrors `SEND_BLOCK_REASON`. */
export const SEND_BLOCK_REASON: Record<SendBlock, string> = {
  "source-missing": "원문 번역을 찾을 수 없습니다",
  "source-unapproved": "원문이 1차 승인 상태가 아닙니다",
  unapproved: "아직 승인되지 않았습니다",
  "source-changed": "원문이 이 문구를 승인한 뒤에 다시 승인됐습니다 — 다시 검수하거나 변환을 새로 하세요",
};

/**
 * Mirrors `SENDS_CLOSED_MESSAGE` in `src/adapters/web/apiHandlers.ts` — what `POST
 * /api/outlets/:id/:type/:outletId/send` answers with while `HERALD_SENDS_ENABLED` is off.
 * `EnvironmentBanner`'s persistent notice and `OutletCard`'s locked [발송]/[재발송] tooltip both use
 * this exact sentence, so an operator reads the same words whether they see it before or after
 * clicking. `tests/web/typeMirror.test.ts` keeps the two byte-identical.
 */
export const SENDS_CLOSED_MESSAGE = "발송이 아직 열려 있지 않습니다 — 1차·2차 승인이 자리잡으면 팀이 직접 엽니다.";

/**
 * What the `**볼드**` in a card's text actually does on that channel, told to the reviewer at the
 * one place they type it.
 *
 * Only `telegram_bot` renders it (`**x**` → `<b>x</b>`); every other emitter calls `stripBold`, so
 * the markers vanish and the words go out plain. KakaoTalk parses no markup at all — its composer
 * offers no formatting, and a pasted `**제목**` would just show the asterisks.
 *
 * This is about the four *channels*, which carry posts and messages. X Articles are rich text and
 * are not one of them: `send:x-article` posts the translation's markdown directly, so the `x` note
 * says "포스트" rather than "X" and points at that path.
 *
 * Mirrors `CHANNEL_RENDERS_BOLD` in the domain, which `tests/domain/formatting/channelBold.test.ts`
 * checks by running the real emitters — so a flag that stops being true fails the suite.
 */
export const CHANNEL_RENDERS_BOLD: Record<Channel, boolean> = {
  x: false,
  telegram: true,
  kakao: false,
  pr_mail: false,
};

export const CHANNEL_FORMAT_NOTE: Record<Channel, string> = {
  // "포스트", not "X": X Articles do carry rich text, and they are a different path (`send:x-article`
  // posts the translation's markdown directly, never touching this channel). The article path is not
  // named here — the reviewer on this card cannot act on it, and the board never rows that outlet.
  x: "X 포스트에는 굵게가 없습니다. **로 감싸도 그대로 평문으로 나갑니다.",
  telegram: "**굵게**는 봇으로 보낼 때만 굵게 보입니다. 복사해서 붙여넣으면 평문입니다.",
  kakao: "카카오톡에는 굵게가 없습니다. **로 감싸도 그대로 평문이고, 강조는 이모지 · [대괄호] · 줄바꿈으로 하세요.",
  pr_mail: "메일 본문은 평문입니다. **로 감싸도 그대로 나갑니다.",
};

/** What one outgoing piece is called on each channel — for "트윗 2개" vs "메시지 2개". */
export const CHANNEL_PIECE: Record<Channel, string> = {
  x: "트윗",
  telegram: "메시지",
  kakao: "메시지",
  pr_mail: "메일",
};

export interface BoardRow {
  outletId: string;
  label: string;
  delivery: "auto" | "manual";
  /** This room has its own text — an override exists for (itemId, type, outletId). */
  forked: boolean;
  /** The room's *resolved* status: a fork carries its own, an unforked room the group's. */
  status: "rendered" | "approved";
  text: string;
  /** Why this room cannot send yet, or absent when it can. Mirrors `SendBlock`. */
  block?: SendBlock;
  /**
   * `dropped` is a scheduled X post whose Typefully draft was deleted before it published — nothing
   * reached the room. It is NOT a third kind of "done": the row must read as sendable, the same as a
   * room with no `deliveryStatus` at all. See `deliveredToRoom` below, the one place that decides
   * which values count.
   */
  deliveryStatus?: "sent" | "delivered" | "dropped";
  /** Sent, but still a scheduled Typefully draft — `at` is when it was queued, not when it posted. */
  awaitingPublish?: boolean;
  /**
   * When this row's `deliveryStatus` was set. For `dropped` this is the moment the post was
   * *scheduled*, not when the draft was later deleted — rendering it as a send/cancel timestamp
   * would claim a precision the ledger does not keep.
   */
  at?: string;
  url?: string;
  /** How many rows on this board address this same room, and which of them this is (1-based). */
  siblingCount: number;
  siblingIndex: number;
}

/**
 * Whether a room's `deliveryStatus` means the room already has this copy — mirrors `deliveredToRoom`
 * in `src/domain/delivery/models.ts` (the frontend cannot import it; see the mirror note above
 * `BoardRow`). `OutletCard` and `OutletBoard` both count a room toward `{n}/{total}곳 완료` through
 * this one predicate rather than each re-deriving it, so the two tallies cannot silently disagree —
 * and so a `dropped` row (a truthy string, same as `sent`/`delivered`) does not accidentally count as
 * done just because `deliveryStatus` is no longer `undefined`.
 *
 * This copy is written as an allowlist (only `sent`/`delivered` count) rather than the domain's
 * denylist (`status !== "dropped"`), because `deliveryStatus` here is also `undefined` for the common
 * case of a room nothing has gone out to — the domain's `status` field is never undefined on a real
 * ledger row, so its denylist has no reason to guard that case, and copying its shape verbatim would
 * silently flip a never-sent room to "done". Nothing about the two functions' *shapes* forces them to
 * agree on a delivery status neither has seen yet — that agreement is pinned by
 * `tests/web/typeMirror.test.ts`, which runs both predicates over every member of the domain's
 * `DeliveryStatus` union and requires the same verdict.
 */
export const deliveredToRoom = (row: Pick<BoardRow, "deliveryStatus">): boolean =>
  row.deliveryStatus === "sent" || row.deliveryStatus === "delivered";

/** One `(type, channel)` rendering plus the rooms that receive it. One card on screen. */
export interface BoardGroup {
  type: ConversionType;
  channel: Channel;
  text: string;
  status: "rendered" | "approved";
  rows: BoardRow[];
  /** Rooms on this channel not rowed yet — the "+ 다른 방 추가" menu. */
  addableOutletIds: string[];
}

export interface BoardView {
  itemId: string;
  groups: BoardGroup[];
  /** Types with no rendering yet, in ALL_TYPES order — the "아직 변환 안 됨" line. */
  unconverted: ConversionType[];
}

/** Every mutating board route answers with the rebuilt board, so nothing is ever painted stale. */
export interface BoardReply {
  board: BoardView;
}
export interface SendReply extends BoardReply {
  sent: number;
  failed: number;
  error?: string;
}

// Mirrors src/app/FormatVariants.ts — one destination's over-limit or otherwise-noteworthy result,
// carried on the /api/items/:id/format response so the board can show what to double-check.
export interface FormatWarning {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  messages: string[];
}

/**
 * `POST /api/items/:id/convert-prepare`. The board cannot convert (no Claude API here, `zod`-only
 * runtime) — this is the worksheet handoff: `pending === 0` means nothing was written (either
 * already converted, or nothing approved yet for the chosen types), so a caller must check it
 * before telling the operator a worksheet is waiting.
 *
 * `archived`, when present, is the path the *previous* unsaved batch was moved to
 * (`output/variants/pending.json` holds one live batch at a time, and preparing again archives
 * whatever was there via `rename`). If the agent was still filling that batch's worksheet, this
 * silently pulls it out from under them — the operator has no terminal to read the CLI's own
 * warning on, so this is the only place that warning can surface.
 */
export interface ConvertPrepareReply {
  worksheetPath: string;
  pending: number;
  archived?: string;
}

/** `POST /api/items/:id/format`. Unlike conversion this always does real work — see `FormatVariants`. */
export interface FormatReply {
  rendered: number;
  warnings: FormatWarning[];
}

/**
 * Mirrors `Headroom` in src/domain/send/headroom.ts — how much Typefully publishing headroom is
 * left. One module on the server computes this, for both the send gate and this banner, so the two
 * can never use different arithmetic. They can still be up to a minute apart on `remaining`: the
 * banner's server-side read is cached, the gate's is not.
 */
export interface Headroom {
  /** The account's raw remaining publishes, for display. */
  remaining: number;
  /** Publishes already spent — the banner's denominator is `used + remaining`. */
  used: number;
  /** Scheduled but unconfirmed sends, across both the delivery and x-article ledgers. */
  inFlight: number;
  /**
   * `remaining − inFlight`, as computed by the server. NOT clamped at the source — it may be
   * negative when a stale in-flight row overcounts. Clamp only when displaying it (see
   * `OutletBoard.tsx`); comparing the raw value is what the send gate does.
   */
  available: number;
  resetsAt: string;
}

/**
 * Mirrors `HeadroomView` in src/domain/send/headroom.ts — the GET /api/typefully/quota payload. An
 * unreadable headroom answers `error` rather than a zero headroom: "unknown" and "exhausted" are
 * different states, and only one of them means the account is actually blocked — rendering a failed
 * read as an empty headroom would paint a healthy account as blocked at `0건`.
 */
export interface HeadroomView {
  headroom?: Headroom;
  error?: string;
}

/** Mirrors `LOW_PUBLISHING_QUOTA` in src/doctor/checks.ts — the CLI and the board agree on "low". */
export const LOW_PUBLISHING_QUOTA = 3;
