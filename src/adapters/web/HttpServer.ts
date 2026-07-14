// src/adapters/web/HttpServer.ts
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { handleApi, type ApiDeps } from "./apiHandlers";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
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

export function startServer(deps: ApiDeps, opts: { port: number; staticDir: string }): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
        const result = await handleApi(deps, req.method ?? "GET", url.pathname, body);
        res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result.json));
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
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}
