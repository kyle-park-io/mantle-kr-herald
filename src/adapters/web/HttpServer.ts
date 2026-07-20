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
