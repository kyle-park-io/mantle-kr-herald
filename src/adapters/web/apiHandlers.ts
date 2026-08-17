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
import type { FunnelCounts } from "../../status/pipeline";
import { emitAll, type Destination, type EmitResult } from "../../domain/formatting/emitters";
import { needsXLinkCta, xLinkCta, appendXLinkCta, X_URL_PENDING } from "../../domain/formatting/xLinkCta";
import { needsKrLinkRewrite, linkedSweptItemIds, rewriteGlobalLinks, krLinkNotice } from "../../domain/formatting/krLinks";
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
import type { LiveProbeResult } from "../../doctor/liveProbes";
import type { LivenessSummary } from "../../status/liveness";
import type { CollectLinkedThread } from "../../app/CollectLinkedThread";

/** Whether a given integration's credentials are present in the env (independent of storage mode). */
export interface IntegrationStatus {
  key: string;
  label: string;
  group: "collect" | "publish" | "send" | "data";
  configured: boolean;
}

export interface StatusView {
  storageMode: StorageMode;
  /** Per stage, the distinct items that reached it and the rows they produced there — see
   *  `src/status/pipeline.ts`'s `funnelCounts`, which the CLI's own funnel is built from too. */
  funnel: FunnelCounts;
  sync: { synced: number; needsRepublish: number; unpublished: number };
  /**
   * Which publish targets this deployment will actually accept — the only thing that enables each
   * `발행` button (`TranslationDetail.tsx`). Two axes, not one: `google`/`lark` are present when their
   * credentials load, and `local` when the route set is `local` (`createDeps.ts`'s
   * `localPublishEnabled` computes that one boolean and uses it for both this field and
   * `publishOne`'s own refusal, the same pairing `sendsEnabled` below uses, so an offered button and
   * an accepted request can never disagree).
   */
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
  /**
   * Whether `POST /api/intake/x` will actually take a link on this deployment — mirrors
   * `deps.collectLinkedThread !== undefined` (`createDeps.ts` computes the one boolean and uses it
   * for both), so the 링크 수집 tab never offers a [넣기] button whose route answers a bare refusal.
   * False means `TWITTERAPI_IO_KEY` is not set here; the pending list still works, since it reads
   * only the database.
   */
  intakeEnabled: boolean;
  /**
   * How the deployment's credentials answered the last time anything asked — the counterpart to
   * `integrations` above, which reports only that a key is present. Absent when nothing has ever
   * probed (a database predating this field, an install that has never deployed) and when the read
   * failed, both of which read on the board as "nothing has looked" rather than as a claim.
   *
   * Graded here rather than in the browser: `web/src` cannot import `liveSeverity`, and a severity
   * table copied into it is a second policy nothing pins.
   */
  liveness?: LivenessSummary;
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

/**
 * Deliberately does not name the cause. Intake is closed by either of two things now — the
 * `HERALD_INTAKE_ENABLED` flag being off, or `TWITTERAPI_IO_KEY` being absent (`createDeps.ts`) —
 * and this sentence is read by a reviewer, who can act on neither. Naming one of the two would be
 * wrong half the time; naming both would explain deployment configuration to someone who came to
 * paste a link. Which of the two it is belongs to `pnpm deploy:check` and `docs/ko/deploy.md`.
 */
export const INTAKE_DISABLED_MESSAGE = "이 배포는 링크 수집이 꺼져 있습니다";

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
  /**
   * 되돌리기's write path — reverses `RetireTranslation`'s `status: "posted"` back to `translated`
   * while leaving `postedUrl`/`postedAt` on the row (see `createDeps.ts`'s construction of this
   * field, which reuses `SaveTranslation.run` and relies on its preservation of those two columns).
   * That preservation is what stops the next unattended `x:reconcile` tick from re-retiring an item
   * a human just disputed. A plain database write with no credential, so — unlike `sendToOutlet`
   * below — `createDeps.ts` wires this for both route sets, not gated by the hosted/local split.
   */
  unretireTranslation: (itemId: string) => Promise<void>;
  /** 게시됨으로 — the withdrawal of `unretireTranslation`'s dispute. Callers must have checked
   *  `postedUrl` first; this only writes the status. */
  retireTranslation: (itemId: string) => Promise<void>;
  publishOne: (id: string, target: string) => Promise<PublishResult>;
  storageMode: StorageMode;
  formattingStore: FormattingStore;
  conversionStore: ConversionStore;
  saveRendering: SaveRendering;
  approveRendering: ApproveRendering;
  loadStatus: () => Promise<StatusView>;
  loadPublishState: () => Promise<PublishStateRow[]>;
  loadTranslations: () => Promise<ApiTranslation[]>;
  /**
   * The KR X post url for an item, or undefined before it goes up. Read only by the `/emissions`
   * routes, for two questions that are the same question asked about different items:
   *
   * - the item under review, for the 공지 CTA a human copies into a `delivery: "manual"` room —
   *   every KakaoTalk room and two Telegram rooms (`src/domain/formatting/xLinkCta.ts`);
   * - each item an `x` rendering *links to*, so a Korean reader following an inline link stays on
   *   the Korean account (`src/domain/formatting/krLinks.ts`).
   *
   * One reader for both: "has this item's Korean X post gone up?" has a single right answer, and a
   * second resolver would eventually give it a different one.
   */
  loadXPostUrl: (itemId: string) => Promise<string | undefined>;
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
   *
   * `opts` mirrors `SendOptions` in `cli/sendToOutlet.ts` (not imported by name, to keep this
   * adapter's own types self-contained): `resend` re-posts to an already-`sent` room, `pin` asks the
   * sender to pin what it posts. Both read straight off the request body below.
   */
  sendToOutlet?: (itemId: string, type: string, outletId: string, opts?: { resend?: boolean; pin?: boolean }) => Promise<{ sent: number; failed: number; error?: string }>;
  /**
   * Writes a conversion worksheet for the dashboard; the local agent still fills it in. Optional —
   * this is how the route set becomes a property of the entry point (`createDeps.ts`): the hosted
   * deployment has no local agent to hand a worksheet to, so it omits this field entirely rather
   * than supplying one that would misleadingly claim the capability exists. `POST
   * /api/items/:id/convert-prepare` below answers 404 when it is absent — not merely hidden by the
   * frontend, an actually-missing route, since there is no agent on the other end of it to reach.
   */
  prepareConversionRun?: PrepareConversionRun;
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
   * Runs the live credential probes inside this deployment and reports what it found. Present on
   * both route sets: the check is about credentials, not about where the process happens to run,
   * and having it locally means `pnpm serve` exercises the same route in development.
   */
  probeLiveness: () => Promise<LiveProbeResult[]>;
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

/**
 * The same text with every linked Mantle Global post pointed at its Korean version, plus what to
 * tell the reviewer about the ones that have none. See `src/domain/formatting/krLinks.ts` for why
 * this belongs at send/preview time rather than in the stored translation.
 *
 * Resolution runs through `deps.loadXPostUrl` — the same reader `withXLinkCta` above uses, asked
 * about a *different* item. That is the whole difference between the two steps: the CTA asks for the
 * Korean post of the item under review, this asks for the Korean post of each item it *links to*.
 * One dep answers both because the question is identical ("has this item's Korean X post gone up?");
 * a second resolver would be a second answer to it.
 *
 * The lookups are concurrent rather than sequential because they are independent DB reads and a
 * preview is a keystroke away from a reviewer waiting on it. `linkedSweptItemIds` is deduped, so a
 * post linked twice costs one read; production measurements put the count at one or two links per
 * text (`docs/superpowers/specs/2026-08-13-kr-link-rewrite-design.md`).
 *
 * **Runs before `withXLinkCta`, and both run before `emitAll`.**
 *
 * Before `emitAll` is the load-bearing half, for a plainer reason than length: `emitAll`'s output IS
 * the deliverable — the exact strings a human copies out of [복사], and (through `emit`, its
 * single-destination twin) the ones `SendChannels` hands the sender. A rewrite done afterwards would
 * have to be re-applied to every segment of every destination one at a time, or not happen at all.
 *
 * Length is a secondary note, not the argument. Over-limit is indeed measured on what goes out, but
 * substituting one url for another cannot move that verdict here: this rewrite is `x`-type only
 * (`needsKrLinkRewrite`), `x` fans out to the `x` channel alone (`DEFAULT_CHANNELS_BY_TYPE`), and
 * `weightedLength` charges every url a flat t.co 23 whatever its real length
 * (`weightedLength.ts:19,111`). It would start to bite the day a character-counted destination
 * (telegram/kakao) is rewritten too — which is a reason to keep this order, not the reason it holds.
 *
 * Before the CTA is the deliberate half. Today it cannot change a byte: the two predicates are
 * disjoint (`needsKrLinkRewrite` is `x` only, `needsXLinkCta` is 공지 only), so no rendering ever
 * takes both steps, and the CTA carries our own account's url anyway. It is fixed in this order so
 * that a type which one day wants both does not get the answer by accident: the rewrite is a
 * statement about copy this codebase did not author — a near-verbatim translation carrying the
 * source tweet's own links — while the CTA is composed here, from `resolveXPostUrl`'s output. Text
 * we just wrote should not then be re-read as if it might need redirecting.
 */
async function withKrLinks(deps: ApiDeps, type: string, text: string): Promise<{ text: string; notice: string | null }> {
  if (!needsKrLinkRewrite(type)) return { text, notice: null };

  const krUrlByItemId = new Map<string, string>();
  await Promise.all(
    linkedSweptItemIds(text).map(async (linkedItemId) => {
      const krUrl = await deps.loadXPostUrl(linkedItemId);
      if (krUrl !== undefined) krUrlByItemId.set(linkedItemId, krUrl);
    }),
  );

  const { text: rewritten, unresolved } = rewriteGlobalLinks(text, krUrlByItemId);
  return { text: rewritten, notice: krLinkNotice(unresolved) };
}

/**
 * Carries `notice` onto every destination of an already-emitted preview, in front of whatever that
 * destination's emitter had to say.
 *
 * Through `warnings` rather than a field of its own, because that is the channel the dashboard
 * already reads: `OutletCard.tsx` renders each destination's `warnings` under the card (the KakaoTalk
 * fold warning is the same path), so a notice put anywhere else would need new rendering code to be
 * seen at all. In front, because it is the older news — the emitter's warnings are about the text
 * this notice is explaining.
 *
 * Repeated per destination, so the x channel says it twice (`x_paste` and `x_typefully`). Not
 * special-cased: `OutletCard` labels each warning with its destination, and an over-limit warning
 * already doubles up the same way on that channel, so suppressing one copy here would make this one
 * notice behave unlike every other.
 */
function withKrLinkNotice(
  emissions: Partial<Record<Destination, EmitResult>>,
  notice: string | null,
): Partial<Record<Destination, EmitResult>> {
  if (notice === null) return emissions;
  const out: Partial<Record<Destination, EmitResult>> = {};
  for (const [destination, result] of Object.entries(emissions) as [Destination, EmitResult][]) {
    out[destination] = { ...result, warnings: [notice, ...result.warnings] };
  }
  return out;
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

  // Deliberately NOT a field on /api/status: the dashboard calls that on every load, and
  // `createDeps`'s "env only, no live calls" is a property worth keeping rather than an accident.
  // Six external calls per board render would be a different bug.
  if (method === "GET" && segments[1] === "diagnostics" && segments[2] === "live" && segments.length === 3) {
    return { status: 200, json: { probes: await deps.probeLiveness() } };
  }

  // Account-wide, not per item — and deliberately not a field on BoardView: board loads are
  // frequent and the social-set bucket is the smallest rate limit we measured (500/hr).
  if (method === "GET" && segments.length === 3 && segments[1] === "typefully" && segments[2] === "quota") {
    return { status: 200, json: await deps.loadQuota() };
  }

  if (method === "GET" && segments.length === 3 && segments[1] === "publish" && segments[2] === "state") {
    return { status: 200, json: await deps.loadPublishState() };
  }

  if (segments[1] === "intake" && segments.length === 3) {
    // Not gated on `deps.collectLinkedThread`, unlike the POST below: this reads the collection
    // repository only, so an install with no `TWITTERAPI_IO_KEY` can still show the operator what is
    // queued instead of a blank tab that looks broken.
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

  if (method === "GET" && segments.length === 2 && segments[1] === "translations") {
    return { status: 200, json: await deps.loadTranslations() };
  }

  if (segments[1] === "translations" && segments.length >= 3) {
    const id = decodeURIComponent(segments[2]);
    const existing = await findById(deps.translationStore, id);

    /**
     * `게시됨` is terminal, and this is where that is enforced rather than asserted.
     *
     * Three routes below mutate a translation in ways a retired item must not undergo, and each one
     * had exactly one guard: `TranslationDetail.tsx` disabling the button. A disabled button is not a
     * rule — a stale tab, a double submit landing after a concurrent retire, or a plain `curl` with a
     * valid session cookie all reach the handler.
     *
     * - **approve / save.** The design's stated defence against posting the same copy twice is "a
     *   retired item cannot be approved, so it cannot be converted, formatted, or sent" — not a
     *   delivery row. That sentence is only true if the server says so.
     * - **publish.** `PublishTranslations` already skips a `posted` item (see its own comment: the
     *   Drive layer has two statuses, so publishing a third one demotes an approved doc to `review/`
     *   and deletes it). Answering 409 here means the button reports why instead of returning a
     *   silent all-zeros result that looks like a no-op failure.
     *
     * `unretire` is deliberately NOT gated: it is the only route that can move an item off `posted`,
     * so gating it would make the state unescapable. `unapprove` is unreachable for a `posted` item
     * (it is not `approved`) and left alone rather than given a second, redundant spelling of this
     * rule.
     */
    const retired = existing?.status === "posted";
    const RETIRED_CONFLICT = {
      status: 409 as const,
      json: { error: "이미 X에 게시된 것으로 확인된 항목입니다. 되돌리기 후 다시 시도하세요." },
    };

    if (method === "PUT" && segments.length === 3) {
      const koreanText = (body as { koreanText?: unknown })?.koreanText;
      if (typeof koreanText !== "string" || koreanText.trim() === "") {
        return { status: 400, json: { error: "koreanText required" } };
      }
      if (!existing) return { status: 404, json: { error: "not found" } };
      if (retired) return RETIRED_CONFLICT;
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText, approve: false, isReply: existing.isReply, refUrl: existing.refUrl });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "approve") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      if (retired) return RETIRED_CONFLICT;
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText: existing.koreanText, approve: true, isReply: existing.isReply, refUrl: existing.refUrl });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "publish") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      if (retired) return RETIRED_CONFLICT;
      const target = (body as { target?: unknown })?.target;
      if (typeof target !== "string" || target === "") return { status: 400, json: { error: "target required" } };
      return { status: 200, json: await deps.publishOne(existing.itemId, target) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "unapprove") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText: existing.koreanText, approve: false, isReply: existing.isReply, refUrl: existing.refUrl });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    // 되돌리기: dispute a reconcile match. A distinct route from `unapprove` above — this is not "undo
    // my own approval", it is "undo what an unattended reconcile pass decided" — even though both
    // currently land on the same `translated` status.
    if (method === "POST" && segments.length === 4 && segments[3] === "unretire") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.unretireTranslation(existing.itemId);
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    /**
     * 게시됨으로: withdraw the dispute `unretire` filed, putting the item back on `posted`.
     *
     * Without this route `unretire` is a one-way door, and not by oversight — `postedUrl` survives
     * it so the next unattended tick cannot re-retire the item (`ReconcileXPublished`: a row with
     * `postedUrl` set is "never scored — read, not re-matched"), and `RetireTranslation` reports
     * `already-retired` *without writing* for exactly the same reason. Both rules exist to protect a
     * human's correction from being undone by a machine; together they also meant a mis-click was
     * permanent.
     *
     * Gated on `postedUrl`, which is the whole reason this cannot invent history: 게시됨 is
     * restorable only for an item that already carries the evidence it went out. A draft that was
     * never posted has no `postedUrl`, so there is nothing here to restore it *to*.
     *
     * No history-tab write, unlike `RetireTranslation`'s second half: this item was retired once
     * already, so its row exists. And if that original write had failed, reconcile still repairs it
     * — its conjunctive skip re-admits a `postedUrl`-set translation whose rootId is missing from
     * `historyPostIds`, and `RetireTranslation` attempts the history half regardless of `status`.
     */
    if (method === "POST" && segments.length === 4 && segments[3] === "retire") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      if (!existing.postedUrl) {
        return { status: 409, json: { error: "게시 기록이 없는 항목은 게시됨으로 되돌릴 수 없습니다." } };
      }
      await deps.retireTranslation(existing.itemId);
      return { status: 200, json: await findById(deps.translationStore, id) };
    }
  }

  if (segments[1] === "renderings") {
    if (method === "GET" && segments.length === 2) {
      const [renderings, variants, translations] = await Promise.all([
        deps.formattingStore.loadAll(),
        deps.conversionStore.loadAll(),
        // For `sourcePostedAt`/`kind`, and for the `posted` gate below. The 2차 list is per *item*,
        // like 1차, so it shows the same date prefix and 포스트/아티클 badge — which live on the
        // source item, not the rendering.
        deps.loadTranslations(),
      ]);
      const convertedByKey = new Map(variants.map((v) => [`${v.itemId}:${v.type}`, v.convertedText]));
      const sourceById = new Map(translations.map((t) => [t.itemId, t] as const));
      /**
       * **A `posted` item is finished, and its cards do not belong on the 2차 board.**
       *
       * The same rule `FormatVariants` enforces on the write side — read that comment for why
       * `posted` is terminal. It gates what gets *built*, which leaves the cards an item already had
       * when 게시됨 retired it: the ordinary lifecycle is 승인 → 카드 렌더 → 발송 → 게시됨으로, so
       * every item that ever finished left its whole board behind, forever, on the one screen whose
       * job is to say what is left to review.
       *
       * They are not merely stale, they are inert: `sendBlock` answers `source-unapproved` for every
       * room on a `posted` item, so nothing on those cards can be sent, and `pnpm format` refuses to
       * rebuild them. A row that can neither be cleared nor acted on is noise.
       *
       * Filtered on READ rather than deleted, because 되돌리기 exists — it puts the item back to
       * `translated`, and the cards (and their 2차 approvals) have to still be there when it does.
       *
       * `status === "posted"` and nothing else, again matching the write side: an item with no
       * translation row at all is an anomaly, not a finished one, and `translated` is the state
       * 되돌리기 lands in — `sendBlock` already paints that row's block as 원문이 1차 승인 상태가
       * 아닙니다, which is a message written to be read on this board.
       */
      const visible = renderings.filter((r) => sourceById.get(r.itemId)?.status !== "posted");
      const enriched = visible.map((r) => ({
        ...r,
        convertedText: convertedByKey.get(`${r.itemId}:${r.type}`) ?? "",
        // The wire key here stays `postedAt` — `Rendering.postedAt` (web/src/types.ts) has always
        // meant "source post date" with no domain field of that name to collide with (unlike
        // `ApiTranslation`, ChannelRendering carries no `postedAt` at all). Only the READ side needed
        // renaming, to stop pulling from a field name that now means something else on `Translation`.
        postedAt: sourceById.get(r.itemId)?.sourcePostedAt,
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
        const krLinked = await withKrLinks(deps, existing.type, existing.text);
        const previewText = await withXLinkCta(deps, existing.itemId, existing.type, channel, krLinked.text);
        return {
          status: 200,
          json: withKrLinkNotice(emitAll(previewText, channel, deps.xMaxWeighted), krLinked.notice),
        };
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
        // Both steps again, on the room's own copy — a forked row's text is not the group's, so a
        // rewrite done only above would leave the [복사] a human actually uses on that row pointing
        // at the English original.
        const krLinked = await withKrLinks(deps, type, row.text);
        const previewText = await withXLinkCta(deps, itemId, type, channel, krLinked.text);
        return {
          status: 200,
          json: withKrLinkNotice(emitAll(previewText, channel, deps.xMaxWeighted), krLinked.notice),
        };
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
    //
    // With one exception it does not get to opt out of: an item whose 1차 translation is `posted` is
    // finished, and `FormatVariants` renders nothing for it no matter who is asking (see that
    // class's gate for why the skip is not scoped to the scheduler). Such a call 200s with
    // `rendered: 0` and `alreadyPosted: true` — a refusal, not a fault, and 되돌리기 is what reopens
    // the item. The flag is on the reply so a caller can say that instead of showing an unexplained
    // zero; a 400 would be wrong, since the request was well-formed and the item really is done.
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

      const { renderings, warnings, skippedPosted } = await deps.formatVariants.run({ ids: [itemId], types: typesRaw as ConversionType[], channels });
      // `skippedPosted` is at most this one item, so it goes over the wire as the boolean question a
      // caller actually asks — "was nothing rendered because this item is finished?" — rather than
      // as a list the dashboard would have to compare against the id it just sent.
      return { status: 200, json: { rendered: renderings.length, warnings, alreadyPosted: skippedPosted.length > 0 } };
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
      // same room, differing only in that the ledger already holds a row for it. `pin` reads the
      // same way — a per-call opt-in on the same route, not a separate flag.
      const resend = (body as { resend?: unknown })?.resend === true;
      const pin = (body as { pin?: unknown })?.pin === true;
      const result = await deps.sendToOutlet(itemId, type, outletId, { resend, pin });
      // Nothing went out and there is a reason for it (unconfigured room, manual room, sender
      // error): 400 so the dashboard's `json()` helper raises it. A partial send still answers
      // 200 with the board — something did reach a live room, and the rows must reflect that.
      // That includes a `sent > 0` result carrying a pin-failure `error`: the post is live, so this
      // is the SAME "something reached a live room" case, just with a reason attached, not the
      // zero-send refusal below.
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
