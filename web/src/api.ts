import type {
  Translation, PublishResult, Rendering, ConversionType, Channel, AppStatus, PublishStateRow, Emissions,
  BoardView, BoardReply, SendReply, ConvertPrepareReply, FormatReply,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
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

const rPath = (itemId: string, type: ConversionType, channel: Channel) =>
  `/api/renderings/${encodeURIComponent(itemId)}/${type}/${channel}`;

// Only the itemId is encoded — it is the one segment that carries a `:` (`x:1` → `x%3A1`), which is
// exactly what the server's `decodeURIComponent(segments[2])` expects. Types and outlet ids are
// code constants with no URL-significant character in them.
const oPath = (itemId: string, type: ConversionType, outletId: string) =>
  `/api/outlets/${encodeURIComponent(itemId)}/${type}/${outletId}`;

const putOutlet = (itemId: string, type: ConversionType, outletId: string, body: unknown) =>
  fetch(oPath(itemId, type, outletId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<BoardReply>(r));

export const api = {
  list: () => fetch("/api/translations").then((r) => json<Translation[]>(r)),
  edit: (id: string, koreanText: string) =>
    fetch(`/api/translations/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ koreanText }),
    }).then((r) => json<Translation>(r)),
  approve: (id: string) =>
    fetch(`/api/translations/${encodeURIComponent(id)}/approve`, { method: "POST" }).then((r) => json<Translation>(r)),
  publishOne: (id: string, target: string) =>
    fetch(`/api/translations/${encodeURIComponent(id)}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    }).then((r) => json<PublishResult>(r)),
  unapprove: (id: string) =>
    fetch(`/api/translations/${encodeURIComponent(id)}/unapprove`, { method: "POST" }).then((r) => json<Translation>(r)),
  listRenderings: () => fetch("/api/renderings").then((r) => json<Rendering[]>(r)),
  editRendering: (itemId: string, type: ConversionType, channel: Channel, text: string) =>
    fetch(rPath(itemId, type, channel), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => json<Omit<Rendering, "convertedText">>(r)),
  approveRendering: (itemId: string, type: ConversionType, channel: Channel) =>
    fetch(`${rPath(itemId, type, channel)}/approve`, { method: "POST" }).then((r) => json<Omit<Rendering, "convertedText">>(r)),
  /**
   * The destination spellings of a rendering. With `outletId`, the spellings of *that room's*
   * copy — which differs from the group's the moment the room is forked, and is what a human
   * actually pastes or a bot actually posts.
   */
  emissions: (itemId: string, type: ConversionType, channel: Channel, outletId?: string) =>
    fetch(`${rPath(itemId, type, channel)}/emissions${outletId ? `/${outletId}` : ""}`).then((r) => json<Emissions>(r)),
  status: () => fetch("/api/status").then((r) => json<AppStatus>(r)),
  publishState: () => fetch("/api/publish/state").then((r) => json<PublishStateRow[]>(r)),

  board: (itemId: string) => fetch(`/api/items/${encodeURIComponent(itemId)}/board`).then((r) => json<BoardView>(r)),
  /** Gives one room its own text — that is what forking is; there is no separate fork call. */
  editOutlet: (itemId: string, type: ConversionType, outletId: string, text: string) =>
    putOutlet(itemId, type, outletId, { text }),
  approveOutlet: (itemId: string, type: ConversionType, outletId: string) =>
    putOutlet(itemId, type, outletId, { approve: true }),
  /** Deletes the override: the room falls back to the group text *and* the group's approval. */
  revertOutlet: (itemId: string, type: ConversionType, outletId: string) =>
    putOutlet(itemId, type, outletId, { revert: true }),
  sendOutlet: async (itemId: string, type: ConversionType, outletId: string) => {
    const res = await fetch(`${oPath(itemId, type, outletId)}/send`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as Partial<SendReply> & { error?: string };
    if (!res.ok) throw new ApiError(body.error ?? `HTTP ${res.status}`, body.board);
    return body as SendReply;
  },
  markOutlet: (itemId: string, type: ConversionType, outletId: string, delivered: boolean) =>
    fetch(`${oPath(itemId, type, outletId)}/mark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delivered }),
    }).then((r) => json<BoardReply>(r)),

  /**
   * The board cannot convert — no Claude API, `zod`-only runtime — so this writes a worksheet and
   * hands back where it landed; the operator still has to ask the local agent to fill it in.
   */
  convertPrepare: (itemId: string, types: ConversionType[]) =>
    fetch(`/api/items/${encodeURIComponent(itemId)}/convert-prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ types }),
    }).then((r) => json<ConvertPrepareReply>(r)),
  /**
   * Unlike conversion, `FormatVariants` is pure code, so this button really does the work — and
   * overwrites whatever was stored for the given (type, channel) pairs, discarding any edit or
   * approval. The caller is expected to confirm that loss with the operator first.
   */
  formatItem: (itemId: string, types: ConversionType[], channels?: Channel[]) =>
    fetch(`/api/items/${encodeURIComponent(itemId)}/format`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(channels ? { types, channels } : { types }),
    }).then((r) => json<FormatReply>(r)),
};
