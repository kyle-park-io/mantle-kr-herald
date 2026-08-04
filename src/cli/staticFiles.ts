import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";

/** Content types for what `pnpm build:web` actually emits. */
const CONTENT_TYPE: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

/**
 * The bytes to serve for a request path, or `undefined` when there is no build to serve at all.
 *
 * All the IO happens here, and nothing here writes a response — that separation is the point.
 * `serve-hosted.ts` used to do `res.writeHead(200, …).end(await readFile(…))`, which evaluates the
 * receiver before the argument: a missing file left the headers already sent, and the `index.html`
 * fallback's second `writeHead` threw `ERR_HTTP_HEADERS_SENT` out of the handler and ended the
 * process. A single `GET /favicon.ico` from a browser was enough to kill the rehearsal server.
 * A caller that only writes headers once it holds a result cannot make that mistake.
 *
 * Unknown paths fall back to `index.html` here. This does NOT match real Vercel: with no `rewrites`
 * entry in `vercel.json`, Vercel's static layer answers an unknown path with a plain 404 — the
 * dashboard is hash-routed (`web/src/Root.tsx`, `web/src/App.tsx`), so no deep link ever needs a
 * server-side fallback, and none was added (see `docs/ko/setup/vercel.md`). This function's own
 * fallback is this rehearsal server's own leniency (a stale bookmark, a typo while poking around
 * `pnpm serve:hosted`) and stays exactly as lenient — `deploy:smoke` must not assume it of the real
 * deployment, but there is no reason to make this local tool stricter than it needs to be either.
 *
 * A path that resolves outside `distDir` takes the same fallback rather than a distinct refusal.
 * `GET /../../package.json` used to return the repo's own file with a 200 — localhost-bound and a
 * rehearsal tool, but there is no reason for it to read anything the build did not produce, and
 * answering identically to any other unknown path keeps it from reporting what exists out there.
 */
export async function readStatic(distDir: string, urlPath: string): Promise<StaticFile | undefined> {
  const root = resolve(distDir);
  const requested = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = resolve(root, requested);

  // `startsWith(root + sep)` and not `startsWith(root)`: a sibling directory whose name merely
  // begins with the same characters (`web/dist-old`) is outside, and must not pass.
  const contained = full === root || full.startsWith(root + sep);

  const read = async (path: string): Promise<Buffer | undefined> => {
    try {
      return await readFile(path);
    } catch {
      // Missing, a directory (EISDIR), unreadable — all "not a file we can serve".
      return undefined;
    }
  };

  const body = contained ? await read(full) : undefined;
  if (body) return { body, contentType: CONTENT_TYPE[extname(full)] ?? "application/octet-stream" };

  const fallback = await read(resolve(root, "index.html"));
  return fallback ? { body: fallback, contentType: CONTENT_TYPE[".html"] } : undefined;
}
