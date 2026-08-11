import type {
  Translation, PublishResult, Rendering, ConversionType, Channel, AppStatus, PublishStateRow, Emissions,
  BoardView, BoardReply, SendReply, ConvertPrepareReply, FormatReply, HeadroomView,
} from "./types";

/**
 * What `json()` does when the server answers 401 — by default nothing, since a call made before
 * `Root.tsx` has installed the real handler (below) has nowhere sensible to go. `Root.tsx` installs
 * the real one once, at module load, before any request that could hit this path; `installUnauthenticatedHandler`
 * exists so tests can install their own and observe the call without touching `window.location`.
 */
let notifyUnauthenticated: () => void = () => {};

export function installUnauthenticatedHandler(handler: () => void): void {
  notifyUnauthenticated = handler;
}

/**
 * A refused request that came back with the server's own rebuilt board.
 *
 * A send is refused mostly because the server's view has moved on — the row was already delivered
 * from a terminal `pnpm send:channels` while this screen was open. Showing the reason and leaving
 * the row as it was would keep offering [발송] for something already sent, so the board travels
 * with the error and the caller repaints from it.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly board?: BoardView,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The one fetch every API call in this module goes through — `reconcile` and `sendOutlet` included,
 * even though they interpret their own response bodies further. `notifyUnauthenticated` is invoked
 * here, and only here, on a 401, so no call site — present or future — can add an endpoint and forget
 * the redirect a lost session needs: the same reasoning the server's own gate applies to
 * `refusalReason()`, done once before every request rather than per call site.
 *
 * A non-401, non-ok response throws `ApiError` (message + the `board` the server may have attached),
 * so it does not redirect anyone on its own — a domain refusal like `이미 발송된 방입니다` is not a
 * lost session, and `OutletCard` needs the board it carries to repaint in place, not a bounce to
 * `#login`.
 */
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401) notifyUnauthenticated();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; board?: BoardView };
    throw new ApiError(body.error ?? `HTTP ${res.status}`, body.board);
  }
  return res.json() as Promise<T>;
}

const rPath = (itemId: string, type: ConversionType, channel: Channel) =>
  `/api/renderings/${encodeURIComponent(itemId)}/${type}/${channel}`;

// Only the itemId is encoded — it is the one segment that carries a `:` (`x:1` → `x%3A1`), which is
// exactly what the server's `decodeURIComponent(segments[2])` expects. Types and outlet ids are
// code constants with no URL-significant character in them.
const oPath = (itemId: string, type: ConversionType, outletId: string) =>
  `/api/outlets/${encodeURIComponent(itemId)}/${type}/${outletId}`;

const putOutlet = (itemId: string, type: ConversionType, outletId: string, body: unknown) =>
  json<BoardReply>(oPath(itemId, type, outletId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const api = {
  /**
   * Rejects with the server's own message, which is the same for a wrong id and a wrong password —
   * the screen must not fill that in from the client side either.
   */
  login: (username: string, password: string) =>
    json<{ ok: true }>("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
  /**
   * Clears the session cookie in this browser only. The token itself remains valid until it expires
   * (2h) or the team rotates `HERALD_SESSION_SECRET` — there is no server-side record of individual
   * sessions to revoke one from (see `apiHandlers.ts`'s logout route). The dashboard's sign-out
   * control; see `App.tsx`.
   */
  logout: () => json<{ ok: true }>("/api/logout", { method: "POST" }),
  list: () => json<Translation[]>("/api/translations"),
  edit: (id: string, koreanText: string) =>
    json<Translation>(`/api/translations/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ koreanText }),
    }),
  approve: (id: string) => json<Translation>(`/api/translations/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  publishOne: (id: string, target: string) =>
    json<PublishResult>(`/api/translations/${encodeURIComponent(id)}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    }),
  unapprove: (id: string) => json<Translation>(`/api/translations/${encodeURIComponent(id)}/unapprove`, { method: "POST" }),
  /** 되돌리기 — disputes a reconcile match. `postedUrl`/`postedAt` survive on the server; see
   *  `TranslationDetail`'s own doc comment on `onUnretire` for why that is load-bearing. */
  unretire: (id: string) => json<Translation>(`/api/translations/${encodeURIComponent(id)}/unretire`, { method: "POST" }),
  retire: (id: string) => json<Translation>(`/api/translations/${encodeURIComponent(id)}/retire`, { method: "POST" }),
  listRenderings: () => json<Rendering[]>("/api/renderings"),
  editRendering: (itemId: string, type: ConversionType, channel: Channel, text: string) =>
    json<Omit<Rendering, "convertedText">>(rPath(itemId, type, channel), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  approveRendering: (itemId: string, type: ConversionType, channel: Channel, approve = true) =>
    json<Omit<Rendering, "convertedText">>(`${rPath(itemId, type, channel)}/${approve ? "approve" : "unapprove"}`, {
      method: "POST",
    }),
  /**
   * The destination spellings of a rendering. With `outletId`, the spellings of *that room's*
   * copy — which differs from the group's the moment the room is forked, and is what a human
   * actually pastes or a bot actually posts.
   */
  emissions: (itemId: string, type: ConversionType, channel: Channel, outletId?: string) =>
    json<Emissions>(`${rPath(itemId, type, channel)}/emissions${outletId ? `/${outletId}` : ""}`),
  status: () => json<AppStatus>("/api/status"),
  publishState: () => json<PublishStateRow[]>("/api/publish/state"),

  /**
   * Runs the deployment's credential probes — ~11 outbound requests under a five-second deadline, so
   * only ever from a click. The response body is not read: the route records what it observed, and
   * the caller re-reads `/api/status` for the graded summary rather than grading in the browser.
   */
  liveness: () => json<{ probes: unknown[] }>("/api/diagnostics/live"),

  /**
   * How much Typefully publishing headroom is left, for the board banner. Always resolves — a
   * non-401 error from the server itself already answers 200 with `{ error }` (unreadable headroom
   * is information for the banner, not a client error), and the `catch` below absorbs everything
   * else (including a 401, after `json()` has already fired the redirect hook), so this never
   * throws; a missing `headroom` means "show nothing".
   */
  typefullyQuota: async (): Promise<HeadroomView> => {
    try {
      return await json<HeadroomView>("/api/typefully/quota");
    } catch {
      return {};
    }
  },

  /**
   * Ask Typefully whether the scheduled X drafts have published, and pull their real urls in. A
   * draft can also come back `gone` — deleted before it published — in which case the row this
   * itemId cares about was retired (`dropped`), not published; `retired` has to be on this type or
   * a caller has no way to tell "still waiting" from "will never happen" apart.
   */
  reconcile: (itemId: string) =>
    json<{ reconciled: number; retired: number; pending: number; board: BoardView }>(
      `/api/items/${encodeURIComponent(itemId)}/reconcile`,
      { method: "POST" },
    ),
  board: (itemId: string) => json<BoardView>(`/api/items/${encodeURIComponent(itemId)}/board`),
  /** Gives one room its own text — that is what forking is; there is no separate fork call. */
  editOutlet: (itemId: string, type: ConversionType, outletId: string, text: string) =>
    putOutlet(itemId, type, outletId, { text }),
  approveOutlet: (itemId: string, type: ConversionType, outletId: string, approve = true) =>
    putOutlet(itemId, type, outletId, { approve }),
  /** Deletes the override: the room falls back to the group text *and* the group's approval. */
  revertOutlet: (itemId: string, type: ConversionType, outletId: string) =>
    putOutlet(itemId, type, outletId, { revert: true }),
  /**
   * `opts.pin` asks the server to pin what it posts — meaningful only on a Telegram room; the
   * dashboard only ever sets it there (`OutletCard`'s `pinOffered`), but the route itself accepts it
   * unconditionally, the same way the CLI's `--pin` does, so this stays a plain pass-through rather
   * than a channel check duplicated on the client.
   */
  sendOutlet: (itemId: string, type: ConversionType, outletId: string, opts: { resend?: boolean; pin?: boolean } = {}) =>
    json<SendReply>(`${oPath(itemId, type, outletId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resend: opts.resend ?? false, pin: opts.pin ?? false }),
    }),
  markOutlet: (itemId: string, type: ConversionType, outletId: string, delivered: boolean) =>
    json<BoardReply>(`${oPath(itemId, type, outletId)}/mark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delivered }),
    }),

  /**
   * The board cannot convert — no Claude API, `zod`-only runtime — so this writes a worksheet and
   * hands back where it landed; the operator still has to ask the local agent to fill it in.
   */
  convertPrepare: (itemId: string, types: ConversionType[]) =>
    json<ConvertPrepareReply>(`/api/items/${encodeURIComponent(itemId)}/convert-prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ types }),
    }),
  /**
   * Unlike conversion, `FormatVariants` is pure code, so this button really does the work — and
   * overwrites whatever was stored for the given (type, channel) pairs, discarding any edit or
   * approval. The caller is expected to confirm that loss with the operator first.
   */
  /**
   * Re-render a rendering from its variant — `pnpm format` narrowed to one (item, type, channel).
   * Parked with no caller: the board's [포맷 다시] button was removed pending a different flow, and
   * the route (and its tests) stay live for whatever replaces it.
   */
  formatItem: (itemId: string, types: ConversionType[], channels?: Channel[]) =>
    json<FormatReply>(`/api/items/${encodeURIComponent(itemId)}/format`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(channels ? { types, channels } : { types }),
    }),
};
