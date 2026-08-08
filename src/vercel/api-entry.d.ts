/**
 * The type declaration for the *bundle*, copied to `dist/api-entry.d.ts` by `pnpm build:api`.
 *
 * `api/[...path].ts` re-exports `../dist/api-entry.js`, which esbuild emits as plain JavaScript with
 * no declarations. Vercel type-checks the function file during every build, so every deploy printed:
 *
 *   api/[...path].ts(30,33): error TS7016: Could not find a declaration file for module
 *   '../dist/api-entry.js'. '/vercel/path0/dist/api-entry.js' implicitly has an 'any' type.
 *
 * It never failed a build — the deployment went Ready and the smoke test passed — which is exactly
 * why it was worth removing. A red line printed on every single deploy is a red line nobody reads,
 * and the next one to appear there is the one that matters.
 *
 * **Structural, deliberately not `export … from "../src/vercel/entry"`.** Re-exporting the real
 * source is the obvious way to make this impossible to drift, and it was tried: it does resolve the
 * error, but it also pulls all of `src/` into Vercel's typecheck of the function file, where it is
 * compiled with Vercel's options rather than this repo's `tsconfig.json`. Locally that immediately
 * produced a dozen `TS2322`s in the `Pg*` stores that `pnpm typecheck` does not report. Trading one
 * harmless red line for a dozen misleading ones is not a fix.
 *
 * Drift is handled by a test instead, not by hope: `tests/deploy/functionBundle.test.ts` assigns the
 * real module's exports to these types, so a change to `entry.ts` that breaks this contract fails
 * `pnpm typecheck`. The contract is complete because `api/[...path].ts` re-exports exactly these two
 * names and nothing else.
 */
export declare const config: { runtime: string };
declare const handler: { fetch: (request: Request) => Promise<Response> };
export default handler;
