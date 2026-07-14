import type { Translation, PublishResult } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

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
  publish: (target: string) =>
    fetch("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    }).then((r) => json<PublishResult>(r)),
};
