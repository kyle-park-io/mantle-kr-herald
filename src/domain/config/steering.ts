/**
 * Which files in the `translation/` and `conversion/` trees are *steering configuration* — the team
 * assets a fresh checkout must be handed and the deploy checkout must be frozen with.
 *
 * The tree holds two unrelated kinds of git-ignored file, and until this module existed every list
 * of "the steering config" was derived by enumeration (`FsConfigFileStore.list()` takes every
 * non-`.example.` file; `deploy-freeze.ts` takes every `git check-ignore` hit), so the two were
 * indistinguishable:
 *
 * - **Configuration** — `glossary.json`, `style-guide.md`, `locale.json`, `tm.json`, the per-type
 *   `conversion/<type>.md` guides and their checklists. Read at runtime, curated by hand (or, for
 *   `tm.json`, by `tm:promote`), and lost forever if the one machine holding them dies.
 * - **`db:export` artifacts** — `translation/few-shot.json` and `conversion/few-shot.<type>.json`.
 *   Since the hosted-writes cutover the few-shot corpus lives in the `few_shot_examples` table:
 *   `SaveTranslation`/`ApproveRendering` write `PgFewShotStore`, `PrepareTranslations`/
 *   `PrepareConversions` read it, and **nothing reads these files at runtime**. The only code that
 *   still touches them is `db-export.ts` (writes) and `db-import.ts` (reads) — the documented
 *   rollback path, which addresses them by exact path and never through this predicate.
 *
 * `db-import.ts`'s own doc comment predicted the confusion this fixes: leaving the files on disk
 * "would make `config:push` keep reporting success while syncing a snapshot frozen at cutover". The
 * fix is not to delete them — they are the rollback path and must exist — but to stop the steering
 * sync from mistaking an export artifact for configuration.
 */

/**
 * `few-shot.json` (translation scope) and `few-shot.<type>.json` (conversion scope), in either the
 * real or the `.example.` spelling.
 *
 * Deliberately not a `startsWith("few-shot")` test: `tm.json` is also a `FewShotStore` in the code
 * (`new JsonFewShotStore(dir, "tm.json")`), it is genuinely read by `translate:prepare` and
 * `translate:align` at runtime, and it must keep syncing. Only the two file *names* the exporter
 * writes are export artifacts.
 */
export function isFewShotExport(fileName: string): boolean {
  return /^few-shot(\.[^/]+)?\.json$/.test(fileName);
}

/** The committed skeletons — never part of any sync; a clone already has them. */
export function isExampleFile(fileName: string): boolean {
  return fileName.includes(".example.");
}

/**
 * `fileName` is a bare entry name (`glossary.json`), not a path. Callers enumerate one directory at
 * a time, and a path-shaped argument would make `.example.` matching depend on the directory name.
 */
export function isSteeringConfigFile(fileName: string): boolean {
  return !isExampleFile(fileName) && !isFewShotExport(fileName);
}
