// api/[...path].ts
//
// The file Vercel turns into the Function, and nothing more. The body lives in `src/vercel/entry.ts`;
// this re-exports the *bundle* built from it (`pnpm build:api`, run by `vercel.json`'s buildCommand
// before the function is built).
//
// Why it cannot just be the entry point itself, which is what it was until 2026-08-05:
//
// `package.json` declares `"type": "module"`, and `@vercel/node` reads that as "already ESM, do not
// transpile to CJS" (packages/node/src/build.ts upstream). It then compiles each `.ts` to `.js`
// in place and traces the tree with `@vercel/nft` — it does not rewrite import specifiers and does
// not bundle. This repo writes relative imports without extensions (1015 of them, the style
// `moduleResolution: "bundler"` and `tsx` both accept), and Node's own ESM resolver does not. So the
// deployed function shipped with `src/adapters/db/createDb.js` present and an import of
// `"../src/adapters/db/createDb"` next to it, and every request died:
//
//   ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/src/adapters/db/createDb'
//
// The static SPA was served by Vercel's own static layer and kept returning 200, so the deployment
// looked healthy from outside while `/api/*` was uniformly 500.
//
// `esbuild --bundle --packages=external` resolves those specifiers at build time and inlines them
// into one file, leaving bare imports (`pg`, `@vercel/functions`) for Node to resolve from
// node_modules as usual. The specifier below carries its `.js` extension, which is the one thing
// Node's resolver needs from us here.
//
// The alternative — adding `.js` to all 1015 relative imports across 222 files and moving to
// `moduleResolution: "nodenext"` — is the more orthodox ESM answer and remains open. It was not
// taken under a broken production deployment.
export { config, default } from "../dist/api-entry.js";
