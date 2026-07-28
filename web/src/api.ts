import type {
  Translation, PublishResult, Rendering, ConversionType, Channel, AppStatus, PublishStateRow, Emissions,
  BoardView, BoardReply, SendReply,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
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
  emissions: (itemId: string, type: ConversionType, channel: Channel) =>
    fetch(`${rPath(itemId, type, channel)}/emissions`).then((r) => json<Emissions>(r)),
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
  sendOutlet: (itemId: string, type: ConversionType, outletId: string) =>
    fetch(`${oPath(itemId, type, outletId)}/send`, { method: "POST" }).then((r) => json<SendReply>(r)),
  markOutlet: (itemId: string, type: ConversionType, outletId: string, delivered: boolean) =>
    fetch(`${oPath(itemId, type, outletId)}/mark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delivered }),
    }).then((r) => json<BoardReply>(r)),
};
