import "./registerErrorHandler";
// src/cli/serve-hosted.ts
//
// The hosted board, locally. `pnpm serve` cannot stand in for it: `createDeps.ts` gives the local
// entry point `routes: "local"`, which always builds `prepareConversionRun` and always sends
// (`sendsEnabled = routes === "local" || loadSendsEnabled()`). So the two things the hosted
// deployment does differently — `[변환 준비]` absent, `[발송]` closed until the flag is on — are the
// exact two things `pnpm serve` can never show. Preview deployments are off by decision
// (`vercel.json`), so without this there is no way to look at the hosted board before production.
//
// It drives `api/[...path].ts`'s own exported `createHandler` — the same function the Vercel
// Function calls — rather than reimplementing any part of it, so what is on screen here is what the
// deployment does. Only two things are stood in for, both platform-owned rather than app code:
// Vercel's static layer (which serves `outputDirectory` itself) and its edge, which is why the
// origin below is passed directly instead of read through `loadDeploymentOrigin()`.
import { createServer } from "node:http";
import { join } from "node:path";
import { Pool } from "pg";
import { wrapPool } from "../adapters/db/createDb";
import { createDeps } from "../app/createDeps";
import { createHandler, assertTrustProxy } from "../../api/[...path]";
import { loadDbConfig, loadClientIpConfig } from "../config";
import { readStatic } from "./staticFiles";
import { REPO_ROOT } from "../paths";

const port = Number(process.env.PORT) || 5758;
/**
 * `loadDeploymentOrigin()` refuses anything that is not https, correctly — on the real deployment a
 * plaintext origin in the CSRF allowlist would be a hole. Nothing is served over https here, so the
 * origin is constructed rather than read. This is the one place this file knowingly differs from
 * `getHandler()`; everything the allowlist then DOES with the value is `createHandler`'s own code,
 * unchanged, so an origin mismatch still refuses here exactly as it would in production.
 */
const origin = `http://localhost:${port}`;
const distDir = join(REPO_ROOT, "web", "dist");

// Same fail-fast order the real entry point uses, and for the same reason: a rehearsal that quietly
// ran without the per-IP lockout would be rehearsing a deployment nobody is going to ship.
//
// `getHandler()`'s other startup refusal, `assertCloudStorage`, is deliberately NOT mirrored here —
// this is the second place this file knowingly differs, alongside the http origin above. The
// rehearsal runs against a disposable local Postgres with no cloud credentials at all
// (DEPLOY.md §5-1), which is the whole point: it exercises the hosted ROUTE SET without touching the
// team's Drive. Asserting cloud storage here would make that impossible. What the assertion protects
// — approved documents landing on an ephemeral filesystem — cannot happen to a rehearsal that is
// itself throwaway.
const dbConfig = loadDbConfig();
assertTrustProxy(loadClientIpConfig());

const pool = new Pool({ connectionString: dbConfig.url });
const deps = createDeps({ db: wrapPool(pool), routes: "hosted" });
const handle = createHandler(deps, origin);

createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? "/").split("?")[0];

    if (!path.startsWith("/api/")) {
      // All the reading happens before a single header is written — see `readStatic`'s own comment
      // for the two bugs that ordering fixes (a missing file used to end the process, and the path
      // was not contained to `distDir`). `readStatic` also owns the `index.html` fallback for paths
      // the SPA's own router handles, matching what `vercel.json`'s `outputDirectory` does.
      //
      // `no-store`: the SPA bundle is content-hashed but `index.html` is not, so a rebuild between
      // two rehearsal runs would otherwise be checked against the previous bundle — which is exactly
      // what happened the first time this was used, and cost a wrong conclusion about a fix.
      const file = await readStatic(distDir, path);
      if (!file) {
        res
          .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          .end(`No web/dist — run \`pnpm build:web\` first.`);
        return;
      }
      res.writeHead(200, { "content-type": file.contentType, "cache-control": "no-store" }).end(file.body);
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }

    const response = await handle(
      new Request(`${origin}${req.url}`, {
        method: req.method,
        headers,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      }),
    );

    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
  })();
}).listen(port, () => {
  console.log(`Hosted board (routes: "hosted") on ${origin}  (build the UI first: pnpm build:web)`);
  console.log(`Sends are ${deps.sendToOutlet ? "OPEN" : "CLOSED"}; [변환 준비] is ${deps.prepareConversionRun ? "present" : "absent"}.`);
});
