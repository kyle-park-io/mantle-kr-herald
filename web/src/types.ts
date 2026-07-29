/** The original tweet URL for an `x:<id>` item, else null (lark items have no public URL). */
export const itemUrl = (itemId: string): string | null =>
  itemId.startsWith("x:") ? `https://x.com/i/status/${itemId.slice(2)}` : null;

/** An ISO date → a compact `[YYMMDD]` prefix (the original post date); "" when absent. */
export const datePrefix = (iso?: string): string =>
  iso && iso.length >= 10 ? `[${iso.slice(2, 10).replace(/-/g, "")}]` : "";

export interface Translation {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  status: "translated" | "approved";
  translatedAt: string;
  approvedAt?: string;
  kind?: "post" | "article";
  postedAt?: string; // source post date (ISO), for the [YYMMDD] prefix
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

export interface AppStatus {
  storageMode: StorageMode;
  availableTargets: ("local" | "google" | "lark")[];
  funnel: { collected: number; translated: number; converted: number; rendered: number; published: number };
  sync: { synced: number; needsRepublish: number; unpublished: number };
  integrations: IntegrationStatus[];
  /** Header links to the team workbooks — absent when the id is not configured. */
  sheetLinks: { data?: SheetLink; qa?: SheetLink };
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
  deliveryStatus?: "sent" | "delivered";
  /** Sent, but still a scheduled Typefully draft — `at` is when it was queued, not when it posted. */
  awaitingPublish?: boolean;
  at?: string;
  url?: string;
  /** How many rows on this board address this same room, and which of them this is (1-based). */
  siblingCount: number;
  siblingIndex: number;
}

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
 * Mirrors `Headroom` in src/cli/publishHeadroom.ts — how much Typefully publishing headroom is left.
 * One module on the server computes this once, for both the send gate and this banner, so the two
 * can never name two different numbers.
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
 * Mirrors `HeadroomView` in src/cli/publishHeadroom.ts — the GET /api/typefully/quota payload. An
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
