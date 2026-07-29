import type { SheetLink } from "../../config";

interface TokenSource {
  getToken(): Promise<string>;
}

/**
 * Replace each link's placeholder title with the workbook's real one.
 *
 * The header names the sheets a reviewer is about to open, and a hardcoded label goes stale the day
 * someone renames the workbook — which nothing in this repo would notice. Fetched once and cached
 * for the process: titles change about never, and `/api/status` is polled.
 *
 * Every failure is swallowed. A missing scope, an id pointing at a deleted sheet, no network — all
 * of them leave the placeholder title and a working link, because this is a convenience on a
 * dashboard whose actual job is reviewing copy.
 */
export function resolveSheetTitles(auth: () => Promise<TokenSource>, fetchFn: typeof fetch = fetch) {
  const cache = new Map<string, string>();

  const titleFor = async (url: string): Promise<string | undefined> => {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    const id = /\/spreadsheets\/d\/([^/]+)/.exec(url)?.[1];
    if (!id) return undefined;
    try {
      const token = await (await auth()).getToken();
      const res = await fetchFn(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return undefined;
      const title = (await res.json() as { properties?: { title?: string } }).properties?.title;
      if (!title) return undefined;
      cache.set(url, title);
      return title;
    } catch {
      return undefined;
    }
  };

  return async (links: { data?: SheetLink; qa?: SheetLink }): Promise<{ data?: SheetLink; qa?: SheetLink }> => {
    const named = async (link?: SheetLink): Promise<SheetLink | undefined> =>
      link ? { ...link, title: (await titleFor(link.url)) ?? link.title } : undefined;
    const [data, qa] = await Promise.all([named(links.data), named(links.qa)]);
    return { ...(data ? { data } : {}), ...(qa ? { qa } : {}) };
  };
}
