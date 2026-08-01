// src/adapters/web/apiHandlers.ts
import type { Translation } from "../../domain/translation/models";
import type { TranslationStore } from "../../ports/TranslationStore";
import type { SaveTranslation } from "../../app/SaveTranslation";
import type { PublishResult } from "../../app/PublishTranslations";
import { ALL_CHANNELS, type ChannelRendering, type Channel } from "../../domain/formatting/models";
import { ALL_TYPES, type ConversionType } from "../../domain/conversion/models";
import type { FormattingStore } from "../../ports/FormattingStore";
import type { ConversionStore } from "../../ports/ConversionStore";
import type { SaveRendering } from "../../app/SaveRendering";
import type { ApproveRendering } from "../../app/ApproveRendering";
import type { StorageMode } from "../../storage/mode";
import { emitAll } from "../../domain/formatting/emitters";
import type { ApiTranslation } from "./attachKind";
import type { SheetLink, ClientIpConfig } from "../../config";
import type { BoardView } from "./board";
import type { SaveOutletOverride } from "../../app/SaveOutletOverride";
import type { MarkDelivery } from "../../app/MarkDelivery";
import type { PrepareConversionRun } from "../../app/PrepareConversionRun";
import type { FormatVariants } from "../../app/FormatVariants";
import type { HeadroomView } from "../../domain/send/headroom";
import type { LoginResult } from "../../app/Login";
import { signSession, type SessionPayload } from "../../domain/auth/session";
import type { SessionConfig } from "../../config";
import { buildSessionCookie, CLEARED_SESSION_COOKIE } from "./sessionCookie";

/** Whether a given integration's credentials are present in the env (independent of storage mode). */
export interface IntegrationStatus {
  key: string;
  label: string;
  group: "collect" | "publish" | "send" | "data";
  configured: boolean;
}

export interface StatusView {
  storageMode: StorageMode;
  funnel: { collected: number; translated: number; converted: number; rendered: number; published: number };
  sync: { synced: number; needsRepublish: number; unpublished: number };
  availableTargets: ("local" | "google" | "lark")[];
  integrations: IntegrationStatus[];
  /** Header links to the team workbooks. A key is absent when its id is not configured. */
  sheetLinks: { data?: SheetLink; qa?: SheetLink };
  /** The attached database's stated `HERALD_DB_ENV`. Consumed by the dashboard banner that warns
   *  when this is not "production" (Plan C's work) — carried here so the two plans do not edit this
   *  interface independently. */
  dbEnv: "production" | "development";
  /**
   * Whether `POST /api/outlets/:id/:type/:outletId/send` is actually reachable — see
   * `ApiDeps.sendToOutlet`'s own comment for the full story. Mirrors `deps.sendToOutlet !==
   * undefined` exactly (`createDeps.ts` computes the one boolean and uses it for both), so the
   * board's banner and the route's own refusal can never disagree about whether sends are open.
   */
  sendsEnabled: boolean;
  /**
   * Whether `POST /api/items/:id/convert-prepare` exists on this deployment — mirrors
   * `deps.prepareConversionRun !== undefined` (`createDeps.ts` computes the one boolean and uses it
   * for both), so the board never offers a [변환 준비] button whose route answers 404.
   */
  conversionEnabled: boolean;
}

export interface PublishStateRow {
  itemId: string;
  status: string;
  target: string;
  url?: string;
  remoteId?: string;
  fileName?: string;
  folderUrl?: string; // NEW — "open folder" for Google/Lark
  fileUrl?: string; // NEW — "open file" for Google/Lark
  /** Whether this row is up to date with the item's current status + content (else: needs republish). */
  synced?: boolean;
}

export interface ApiResult {
  status: number;
  json: unknown;
  /**
   * A `Set-Cookie` header value the caller (`HttpServer`) must send with this response. Present only
   * for `POST /api/login` on success (issuing a session) and `POST /api/logout` (clearing it) —
   * absent, and therefore not sent, for every other route.
   */
  setCookie?: string;
}

export interface ApiDeps {
  translationStore: TranslationStore;
  saveTranslation: SaveTranslation;
  publishOne: (id: string, target: string) => Promise<PublishResult>;
  storageMode: StorageMode;
  formattingStore: FormattingStore;
  conversionStore: ConversionStore;
  saveRendering: SaveRendering;
  approveRendering: ApproveRendering;
  loadStatus: () => Promise<StatusView>;
  loadPublishState: () => Promise<PublishStateRow[]>;
  loadTranslations: () => Promise<ApiTranslation[]>;
  xMaxWeighted: number;
  loadBoard: (itemId: string) => Promise<BoardView>;
  saveOutletOverride: SaveOutletOverride;
  markDelivery: MarkDelivery;
  /**
   * `retired` is load-bearing on the wire, not a statistic: `OutletCard` branches on `res.retired > 0`
   * to say "예약된 게시물이 게시되기 전에 취소되었습니다" instead of the generic "아직 게시되지
   * 않았습니다". The route forwards this through an untyped `{ ...result, board }` spread, so a
   * closure narrowed to `{ reconciled, pending }` would drop it with no type error, no test failure,
   * and `undefined > 0` on the board. Declared here so narrowing it is a compile error.
   */
  reconcilePublished: () => Promise<{ reconciled: number; retired: number; pending: number; error?: string }>;
  /**
   * Posts to a live Telegram room or the brand's X account. Optional — the SAME "route set is a
   * property of the entry point" mechanism `prepareConversionRun` above already established, reused
   * rather than duplicated: Kyle's decision was that the hosted dashboard ships with 1차/2차 approval
   * working and sends refused by an environment flag (`HERALD_SENDS_ENABLED`, `config.ts`), flipped
   * once the team trusts approvals. `createDeps.ts` omits this field entirely — for the hosted route
   * set, until that flag is on — rather than supplying a function that would just refuse every call;
   * `POST /api/outlets/:id/:type/:outletId/send` below checks for its absence before anything else,
   * the same "refuse at the route, not the button" shape `prepareConversionRun` uses for
   * `convert-prepare`. Unlike that route (permanently absent on hosted — there is no local agent to
   * hand a worksheet to, ever), this one is only TEMPORARILY closed, so its refusal carries a Korean
   * reason and the rebuilt board rather than a bare 404: an operator who clicks [발송] while it is
   * closed is told why, through the exact response shape this route's other refusals already use
   * (`SendChannels`-reported errors, just below).
   */
  sendToOutlet?: (itemId: string, type: string, outletId: string, resend?: boolean) => Promise<{ sent: number; failed: number; error?: string }>;
  /**
   * Writes a conversion worksheet for the dashboard; the local agent still fills it in. Optional —
   * this is how the route set becomes a property of the entry point (`createDeps.ts`): the hosted
   * deployment has no local agent to hand a worksheet to, so it omits this field entirely rather
   * than supplying one that would misleadingly claim the capability exists. `POST
   * /api/items/:id/convert-prepare` below answers 404 when it is absent — not merely hidden by the
   * frontend, an actually-missing route, since there is no agent on the other end of it to reach.
   */
  prepareConversionRun?: PrepareConversionRun;
  /** Pure code — unlike conversion, the dashboard can run this one itself. */
  formatVariants: FormatVariants;
  /**
   * How much Typefully publishing headroom is left, for the banner — the same reader
   * (`publishHeadroom.ts`) the send gate (`SendChannels`) reads, so the banner and the gate can never
   * use different arithmetic to compute it. The banner's number can still lag the gate's by up to a
   * minute after an out-of-band publish: the banner's read is cached so it can poll cheaply, the
   * gate's is not. `error` when the headroom itself could not be read; the name `loadQuota` and the
   * always-200 `{ …, error? }` contract stay as they were, only the payload widens.
   */
  loadQuota: () => Promise<HeadroomView>;
  /**
   * Checks the dashboard's one credential behind the two-layer lockout (global + per-IP — see
   * `attemptLimiter.ts`'s doc comment). `clientIp` is the request's own — pass `deps.clientIp`
   * straight through, never a value computed independently, so the limiter this call actually
   * consults and the address `HttpServer.ts` resolved for this same request can never disagree. See
   * `src/app/Login.ts`.
   */
  login: (credentials: { username: string; password: string }, clientIp: string | undefined) => Promise<LoginResult>;
  /**
   * Secret and lifetime for signing a fresh session on a successful login. `HttpServer` reads the
   * same `secret` to verify the request's cookie *before* `handleApi` is ever called — one
   * `SessionConfig` (`loadSessionConfig()`, `src/config.ts`), not two, so the cookie a login hands
   * out and the signature a later request is checked against can never drift onto different secrets
   * or lifetimes.
   */
  sessionConfig: SessionConfig;
  /**
   * Whether — and how — `HttpServer` may trust `X-Forwarded-For` when it computes `clientIp` below
   * for each request. Fixed for the process, unlike `clientIp` itself; see `loadClientIpConfig()`
   * (`src/config.ts`) and `resolveClientIp` (`clientIp.ts`) for what this actually controls.
   */
  ipConfig: ClientIpConfig;
  /**
   * The address `resolveClientIp` (`clientIp.ts`) resolved for THIS request, or `undefined` when
   * none could be trusted — computed by `HttpServer` before `handleApi` runs, the same per-request
   * pattern `session` below already uses, and for the same reason: `handleApi` stays callable (and
   * testable) without a real HTTP request or a real socket. Read by the login route only; every
   * other route ignores it.
   */
  clientIp: string | undefined;
  /**
   * The verified session for THIS request, or `undefined` for none. Computed by `HttpServer` from
   * the incoming `Cookie` header before `handleApi` runs — never derived in here, so `handleApi`
   * stays callable (and testable) without a real HTTP request. Unlike every other field on
   * `ApiDeps`, this one is not fixed for the process: each request gets its own value spread over
   * the same base deps (see `HttpServer.ts`).
   */
  session: SessionPayload | undefined;
}

/**
 * What an operator sees on a locked [발송] click while `deps.sendToOutlet` is closed. Says why,
 * rather than a bare "not found" — see `ApiDeps.sendToOutlet`'s own comment for why this route's
 * refusal shape differs from `convert-prepare`'s.
 */
// Exported so the dashboard (`web/src/types.ts`'s mirror of the same name) can say the identical
// sentence up front — in the board's persistent banner and in a locked [발송]/[재발송] row's own
// tooltip — rather than an operator reading two different Korean sentences for the same refusal
// depending on whether they clicked through or just looked. `tests/web/typeMirror.test.ts` keeps the
// two byte-identical.
export const SENDS_CLOSED_MESSAGE = "발송이 아직 열려 있지 않습니다 — 1차·2차 승인이 자리잡으면 팀이 직접 엽니다.";

/** Board mutations answer with the whole rebuilt board: one round trip, no stale rows on screen. */
type BoardReply = { board: BoardView } & Record<string, unknown>;

async function findById(store: TranslationStore, id: string): Promise<Translation | undefined> {
  return (await store.loadAll()).find((t) => t.itemId === id);
}

/**
 * Whether `method`+`path` is `POST /api/login` — the one route exempt from the session gate.
 * Exported so `HttpServer.ts` can ask the same question before it ever calls `handleApi` (to skip
 * reading a body it is about to refuse anyway); computing this in one place means the pre-body-read
 * gate there and the session gate in here can never disagree about what counts as the login route.
 */
export function isLoginRoute(method: string, path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return method === "POST" && segments.length === 2 && segments[0] === "api" && segments[1] === "login";
}

export async function handleApi(deps: ApiDeps, method: string, path: string, body: unknown): Promise<ApiResult> {
  const segments = path.split("/").filter(Boolean); // ["api", "translations", ...]
  if (segments[0] !== "api") return { status: 404, json: { error: "not found" } };

  const isLogin = isLoginRoute(method, path);

  /**
   * The session gate: one check, before any route below is matched — the same shape
   * `refusalReason()` uses in `HttpServer.ts` for the cross-site guard, so a route added below with
   * no session check of its own is still covered rather than silently reachable.
   *
   * `POST /api/login` is the one exemption: it is what grants a session, so it cannot require one.
   * Every other route — read or write, the board is not public — answers the same 401 with no further
   * detail. Distinguishing "no cookie" from "an expired or forged one" would tell a guesser which
   * half of the problem they still have to solve, the same reasoning the login refusal below applies
   * to a wrong username vs. a wrong password.
   */
  if (!isLogin && !deps.session) {
    return { status: 401, json: { error: "unauthenticated" } };
  }

  if (isLogin) {
    const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || typeof password !== "string") {
      return { status: 400, json: { error: "아이디와 비밀번호가 필요합니다." } };
    }
    const result = await deps.login({ username, password }, deps.clientIp);
    if (result.ok) {
      const token = signSession({ issuedAt: new Date().toISOString() }, deps.sessionConfig.secret);
      return { status: 200, json: { ok: true }, setCookie: buildSessionCookie(token, deps.sessionConfig.ttlMs) };
    }
    if (result.retryAfterMs > 0) {
      return {
        status: 429,
        json: { error: "너무 많이 시도했습니다. 잠시 후 다시 시도해 주세요.", retryAfterMs: result.retryAfterMs },
      };
    }
    // Says nothing about which half was wrong. With a single account, naming the field would tell
    // someone probing when they had found the account name — half the secret — so both failures
    // read identically.
    return { status: 401, json: { error: "아이디 또는 비밀번호가 맞지 않습니다." } };
  }

  /**
   * Clears the cookie in the browser — that is the whole of what this does. The token itself is not
   * revoked: it stays valid, unchanged, until its own `issuedAt + ttlMs` lapses or someone rotates
   * `HERALD_SESSION_SECRET` (see `HttpServer.ts`'s `refusalReason()` comment, and
   * `docs/ko/team-runbook.md`'s rotation note). There is no server-side session list this could
   * delete an entry from, so a copy of the token saved before logout and replayed directly against
   * the API — never touching this browser again — is accepted exactly as before.
   *
   * Gated like every other route above (the only exemption is `/api/login`), which has a
   * consequence worth stating rather than leaving implicit: a caller presenting an expired or forged
   * cookie never reaches this branch — the gate above already answered 401, and no clearing header
   * was ever sent. That is correct (there is no session there to clear), not a bug in this route.
   */
  if (method === "POST" && segments.length === 2 && segments[1] === "logout") {
    return { status: 200, json: { ok: true }, setCookie: CLEARED_SESSION_COOKIE };
  }

  // The frontend cannot know the server's storage mode, and it decides which publish targets to
  // offer — a local-mode dashboard defaulting to "google" would fail on every first click.
  if (method === "GET" && segments.length === 2 && segments[1] === "config") {
    return { status: 200, json: { storageMode: deps.storageMode } };
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "status") {
    return { status: 200, json: await deps.loadStatus() };
  }

  // Account-wide, not per item — and deliberately not a field on BoardView: board loads are
  // frequent and the social-set bucket is the smallest rate limit we measured (500/hr).
  if (method === "GET" && segments.length === 3 && segments[1] === "typefully" && segments[2] === "quota") {
    return { status: 200, json: await deps.loadQuota() };
  }

  if (method === "GET" && segments.length === 3 && segments[1] === "publish" && segments[2] === "state") {
    return { status: 200, json: await deps.loadPublishState() };
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "translations") {
    return { status: 200, json: await deps.loadTranslations() };
  }

  if (segments[1] === "translations" && segments.length >= 3) {
    const id = decodeURIComponent(segments[2]);
    const existing = await findById(deps.translationStore, id);

    if (method === "PUT" && segments.length === 3) {
      const koreanText = (body as { koreanText?: unknown })?.koreanText;
      if (typeof koreanText !== "string" || koreanText.trim() === "") {
        return { status: 400, json: { error: "koreanText required" } };
      }
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText, approve: false, isReply: existing.isReply, refUrl: existing.refUrl });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "approve") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText: existing.koreanText, approve: true, isReply: existing.isReply, refUrl: existing.refUrl });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "publish") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      const target = (body as { target?: unknown })?.target;
      if (typeof target !== "string" || target === "") return { status: 400, json: { error: "target required" } };
      return { status: 200, json: await deps.publishOne(existing.itemId, target) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "unapprove") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText: existing.koreanText, approve: false, isReply: existing.isReply, refUrl: existing.refUrl });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }
  }

  if (segments[1] === "renderings") {
    if (method === "GET" && segments.length === 2) {
      const [renderings, variants, translations] = await Promise.all([
        deps.formattingStore.loadAll(),
        deps.conversionStore.loadAll(),
        // For `postedAt`/`kind` only. The 2차 list is per *item*, like 1차, so it shows the same
        // date prefix and 포스트/아티클 badge — which live on the source item, not the rendering.
        deps.loadTranslations(),
      ]);
      const convertedByKey = new Map(variants.map((v) => [`${v.itemId}:${v.type}`, v.convertedText]));
      const sourceById = new Map(translations.map((t) => [t.itemId, t] as const));
      const enriched = renderings.map((r) => ({
        ...r,
        convertedText: convertedByKey.get(`${r.itemId}:${r.type}`) ?? "",
        postedAt: sourceById.get(r.itemId)?.postedAt,
        kind: sourceById.get(r.itemId)?.kind,
      }));
      return { status: 200, json: enriched };
    }

    if (segments.length >= 5) {
      const itemId = decodeURIComponent(segments[2]);
      const type = segments[3] as ConversionType;
      const channel = segments[4] as Channel;

      if (method === "PUT" && segments.length === 5) {
        const text = (body as { text?: unknown })?.text;
        if (typeof text !== "string" || text.trim() === "") return { status: 400, json: { error: "text required" } };
        const existing = (await deps.formattingStore.loadAll()).find(
          (r) => r.itemId === itemId && r.type === type && r.channel === channel,
        );
        if (!existing) return { status: 404, json: { error: "not found" } };
        await deps.saveRendering.run({ itemId, type, channel, text });
        const updated = (await deps.formattingStore.loadAll()).find(
          (r) => r.itemId === itemId && r.type === type && r.channel === channel,
        );
        return { status: 200, json: updated };
      }

      // Two routes rather than one with a body flag, mirroring `/api/translations/:id/{approve,unapprove}`.
      if (method === "POST" && segments.length === 6 && (segments[5] === "approve" || segments[5] === "unapprove")) {
        const updated = await deps.approveRendering.run({ itemId, type, channel, approve: segments[5] === "approve" });
        if (!updated) return { status: 404, json: { error: "not found" } };
        return { status: 200, json: updated };
      }

      if (method === "GET" && segments.length === 6 && segments[5] === "emissions") {
        const existing = (await deps.formattingStore.loadAll()).find(
          (r) => r.itemId === itemId && r.type === type && r.channel === channel,
        );
        if (!existing) return { status: 404, json: { error: "not found" } };
        return { status: 200, json: emitAll(existing.text, channel, deps.xMaxWeighted) };
      }

      // `…/emissions/:outletId` — the spelling *that room* receives. A forked room's copy is its
      // own, so emitting the group rendering would hand a human the wrong text to paste into a
      // live room. The resolved text is read off the board rather than re-resolved here, so this
      // route and the row on screen can never disagree about what the room's copy is.
      if (method === "GET" && segments.length === 7 && segments[5] === "emissions") {
        const board = await deps.loadBoard(itemId);
        const row = board.groups
          .find((g) => g.type === type && g.channel === channel)
          ?.rows.find((r) => r.outletId === segments[6]);
        if (!row) return { status: 404, json: { error: "not found" } };
        return { status: 200, json: emitAll(row.text, channel, deps.xMaxWeighted) };
      }
    }
  }

  if (segments[1] === "items" && segments.length === 4) {
    const itemId = decodeURIComponent(segments[2]);

    // Board-wide, not per item: one Typefully pass answers for every scheduled draft, and the
    // board reloads from the rebuilt view either way.
    if (method === "POST" && segments[3] === "reconcile") {
      const result = await deps.reconcilePublished();
      if (result.error) return { status: 400, json: { error: result.error, board: await deps.loadBoard(itemId) } };
      return { status: 200, json: { ...result, board: await deps.loadBoard(itemId) } };
    }

    if (method === "GET" && segments[3] === "board") {
      return { status: 200, json: await deps.loadBoard(itemId) };
    }

    // The board cannot convert (no Claude API, zod-only runtime) — this runs `convert:prepare` and
    // hands back where the worksheet landed. Filling it is the local agent's job; the operator asks
    // for that separately, which is why the reply carries a path rather than converted text.
    if (method === "POST" && segments[3] === "convert-prepare") {
      // Absent on the hosted route set (`createDeps.ts`, `routes: "hosted"`) — the local agent that
      // fills the worksheet is not there. A 404 here, checked before any body validation, is what
      // makes the route genuinely not exist rather than merely reject every request it gets.
      if (!deps.prepareConversionRun) return { status: 404, json: { error: "not found" } };
      const typesRaw = (body as { types?: unknown })?.types;
      if (!Array.isArray(typesRaw) || typesRaw.length === 0) {
        return { status: 400, json: { error: "types (non-empty array) required" } };
      }
      const invalid = typesRaw.filter((t) => typeof t !== "string" || !ALL_TYPES.includes(t as ConversionType));
      if (invalid.length > 0) return { status: 400, json: { error: `invalid types: ${invalid.join(", ")}` } };
      const result = await deps.prepareConversionRun.run({ itemId, types: typesRaw as ConversionType[] });
      return { status: 200, json: result };
    }

    // Unlike conversion, `FormatVariants` is pure code — this button really does the work, and
    // overwrites whatever was stored (including an edit or an approval) for the chosen (type,
    // channel) pairs. The dashboard is expected to confirm that loss with the operator before
    // calling this; the route itself does not ask twice.
    if (method === "POST" && segments[3] === "format") {
      const b = (body ?? {}) as { types?: unknown; channels?: unknown };
      const typesRaw = b.types;
      if (!Array.isArray(typesRaw) || typesRaw.length === 0) {
        return { status: 400, json: { error: "types (non-empty array) required" } };
      }
      const invalidTypes = typesRaw.filter((t) => typeof t !== "string" || !ALL_TYPES.includes(t as ConversionType));
      if (invalidTypes.length > 0) return { status: 400, json: { error: `invalid types: ${invalidTypes.join(", ")}` } };

      let channels: Channel[] | undefined;
      if (b.channels !== undefined) {
        // Same non-empty rule as `types` just above: `FormatVariants` reads `channels` with `??`,
        // so an empty array is never replaced by its per-type defaults — it would 200 and silently
        // render nothing, rather than reject like every other malformed request on this route.
        if (!Array.isArray(b.channels) || b.channels.length === 0) {
          return { status: 400, json: { error: "channels, if present, must be a non-empty array" } };
        }
        const invalidChannels = b.channels.filter((c) => typeof c !== "string" || !ALL_CHANNELS.includes(c as Channel));
        if (invalidChannels.length > 0) return { status: 400, json: { error: `invalid channels: ${invalidChannels.join(", ")}` } };
        channels = b.channels as Channel[];
      }

      const { renderings, warnings } = await deps.formatVariants.run({ ids: [itemId], types: typesRaw as ConversionType[], channels });
      return { status: 200, json: { rendered: renderings.length, warnings } };
    }
  }

  if (segments[1] === "outlets" && segments.length >= 5) {
    const itemId = decodeURIComponent(segments[2]);
    const type = segments[3];
    const outletId = segments[4];
    // `SaveOutletOverride` and `MarkDelivery` refuse the moves that would corrupt the ledger
    // (an unknown room, ticking an auto room, unticking a bot's `sent` row). Those refusals are the
    // operator asking for something impossible, not a server fault — 400 with the reason, so the
    // dashboard can show it, rather than the 500 an uncaught throw would produce.
    const reply = async (extra: Record<string, unknown> = {}): Promise<ApiResult> => ({
      status: 200,
      json: { ...extra, board: await deps.loadBoard(itemId) } satisfies BoardReply,
    });
    const refuse = (err: unknown): ApiResult => ({
      status: 400,
      json: { error: err instanceof Error ? err.message : String(err) },
    });

    if (method === "PUT" && segments.length === 5) {
      const b = (body ?? {}) as { text?: unknown; approve?: unknown; revert?: unknown };
      // `approve` is matched on both booleans, not truthiness: `false` is the 승인 취소 request, and
      // reading it as "absent" would fall through to the text branch and 400 on a valid call.
      const input =
        b.revert === true ? { revert: true }
        : typeof b.approve === "boolean" ? { approve: b.approve }
        : typeof b.text === "string" && b.text.trim() !== "" ? { text: b.text }
        : undefined;
      if (!input) return { status: 400, json: { error: "text, approve or revert required" } };
      try {
        const override = await deps.saveOutletOverride.run({ itemId, type, outletId, ...input });
        return await reply({ override: override ?? null });
      } catch (err) {
        return refuse(err);
      }
    }

    if (method === "POST" && segments.length === 6 && segments[5] === "send") {
      // Checked before the resend flag, before anything else: `deps.sendToOutlet`'s own comment on
      // `ApiDeps` has the full story. The board it carries back is what lets the row's [발송] click
      // repaint from an accurate state rather than sitting on a stale one — the same reason the
      // "already delivered" refusal a few lines below carries it too.
      if (!deps.sendToOutlet) {
        return {
          status: 400,
          json: { error: SENDS_CLOSED_MESSAGE, board: await deps.loadBoard(itemId) },
        };
      }
      // `resend` is opt-in per call rather than a separate route: it is the same delivery to the
      // same room, differing only in that the ledger already holds a row for it.
      const resend = (body as { resend?: unknown })?.resend === true;
      const result = await deps.sendToOutlet(itemId, type, outletId, resend);
      // Nothing went out and there is a reason for it (unconfigured room, manual room, sender
      // error): 400 so the dashboard's `json()` helper raises it. A partial send still answers
      // 200 with the board — something did reach a live room, and the rows must reflect that.
      //
      // The refusal carries the rebuilt board too. The commonest one is "already delivered to this
      // room", which means the server's view has moved on — someone ran `pnpm send:channels` in a
      // terminal while this board was open. Answering with the error alone leaves the row still
      // offering [발송] for something already sent, so the screen never self-corrects.
      if (result.sent === 0 && result.error) {
        return { status: 400, json: { error: result.error, board: await deps.loadBoard(itemId) } };
      }
      return await reply({ ...result });
    }

    if (method === "POST" && segments.length === 6 && segments[5] === "mark") {
      const delivered = (body as { delivered?: unknown })?.delivered;
      if (typeof delivered !== "boolean") return { status: 400, json: { error: "delivered (boolean) required" } };
      try {
        await deps.markDelivery.run({ itemId, type, outletId, delivered });
        return await reply();
      } catch (err) {
        return refuse(err);
      }
    }
  }

  return { status: 404, json: { error: "not found" } };
}
