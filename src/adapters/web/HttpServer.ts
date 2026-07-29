// src/adapters/web/HttpServer.ts
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, resolve, sep } from "node:path";
import { handleApi, type ApiDeps } from "./apiHandlers";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Everything an HTML form can post without a preflight. The dashboard sends JSON, or no body. */
const FORM_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An origin served from this machine — the dashboard itself, or Vite's dev server proxying to it. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false; // including `Origin: null` — an opaque origin is not this machine
  }
}

/**
 * Why a request must be refused before it reaches a route, or `undefined`.
 *
 * The server has no auth and binds to 127.0.0.1, but it now performs irreversible live posts, and
 * `POST /api/outlets/:itemId/:type/:outletId/send` takes no body — which makes a cross-site form
 * POST a *simple* request: no preflight, so CORS never gets a say and the browser just sends it,
 * from any page the operator has open. Needing a known `itemId` keeps that impractical; the guard is
 * a few lines and the blast radius changed class in this slice.
 *
 * - **Origin** — present and not loopback: refused. *Any* loopback port is accepted rather than this
 *   server's own, because `pnpm dev:web` serves the UI from Vite on :5173 and proxies `/api` here
 *   with the browser's original `Origin` intact. A page already served from this machine is past
 *   every boundary this could defend anyway.
 * - **content-type** — the three an HTML form can produce are refused outright, which covers a
 *   client that sends no `Origin` at all. Costs nothing: every dashboard call sends JSON or no body.
 *
 * `GET` is untouched, so the SPA, the static files and the local publish reader are unaffected.
 */
export function refusalReason(method: string, origin?: string, contentType?: string): string | undefined {
  if (!STATE_CHANGING.has(method.toUpperCase())) return undefined;
  if (origin !== undefined && !isLoopbackOrigin(origin)) return "cross-site request refused";
  if (contentType && FORM_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) {
    return "form-encoded request refused";
  }
  return undefined;
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export function startServer(deps: ApiDeps, opts: { port: number; staticDir: string; localPublishDir: string }): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      // Before any route: a state-changing request from somewhere else never reaches a use case.
      const refusal = refusalReason(req.method ?? "GET", req.headers.origin, req.headers["content-type"]);
      if (refusal) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: refusal }));
        return;
      }
      if (url.pathname.startsWith("/api/publish/local/")) {
        try {
          const rel = normalize(decodeURIComponent(url.pathname.slice("/api/publish/local/".length)))
            .replace(/^(\.\.[/\\])+/, "")
            .replace(/^[/\\]+/, "");
          const filePath = join(opts.localPublishDir, rel);
          // Defense in depth: the resolved path must stay under the publish-local root.
          if (resolve(filePath) !== resolve(opts.localPublishDir) && !resolve(filePath).startsWith(resolve(opts.localPublishDir) + sep)) {
            res.writeHead(404).end();
            return;
          }
          const data = await readFile(filePath);
          res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" }).end(data);
        } catch {
          res.writeHead(404).end();
        }
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
        const result = await handleApi(deps, req.method ?? "GET", url.pathname, body);
        const payload = JSON.stringify(result.json);
        res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" }).end(payload);
        return;
      }
      // static: map path to a file under staticDir, default to index.html (SPA fallback)
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
      let filePath = join(opts.staticDir, rel);
      let data: Buffer;
      try {
        data = await readFile(filePath);
      } catch {
        filePath = join(opts.staticDir, "index.html");
        data = await readFile(filePath);
      }
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" }).end(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        res.end();
      } else {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: message }));
      }
    }
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}
