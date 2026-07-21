import type { Translation, PublishResult, Rendering, ConversionType, Channel, AppStatus, PublishStateRow, Emissions } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const rPath = (itemId: string, type: ConversionType, channel: Channel) =>
  `/api/renderings/${encodeURIComponent(itemId)}/${type}/${channel}`;

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
};
