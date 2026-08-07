import "./registerErrorHandler";
import { argValue } from "./args";
import { loadDbConfig, tryDescribeDbTarget, INVALID_DB_URL } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { paths } from "../paths";
import { checkGlossary, type GlossaryMiss } from "../domain/translation/glossaryCompliance";

/**
 * `pnpm translate:check [--status <s>] [--since <ISO>]` — reports translations whose source used a
 * decided glossary term but whose Korean did not use the decided rendering.
 *
 * Read-only. Writes nothing, changes no status, and never exits non-zero on a finding: a glossary
 * has real exceptions, so this is a list a human reads before 1차 검수, not a gate.
 *
 * Why it exists. The drift it catches is invisible one item at a time — `narrative` rendered `이야기`
 * is a perfectly good sentence, wrong only against a decision recorded elsewhere. Measured on
 * 2026-08-07: a batch of nineteen translations drifted from four decided terms, and every individual
 * sentence read fine. A reviewer cannot hold twenty items' terminology in their head; this is the
 * part of that job a machine can actually do.
 *
 * Names its database on the first line, like every other CLI here — this reads production or the
 * local Docker database depending only on which env file was loaded.
 */
const wantStatus = argValue("--status");
const since = argValue("--since");

const dbConfig = loadDbConfig();
console.log(`translate:check — database ${dbConfig.env} · ${tryDescribeDbTarget(dbConfig) ?? INVALID_DB_URL}`);

const db = createDb(dbConfig);
try {
  const stores = createStores(db);
  const [all, glossary] = await Promise.all([
    stores.translationStore.loadAll(),
    new JsonGlossaryStore(paths.translationConfigDir).load(),
  ]);

  // Refuses rather than reporting a clean run. An empty glossary makes every check vacuous, and
  // "no drift found" is the most dangerous thing this command could print in that state — it reads
  // as a pass. This is not hypothetical: the first run of this command printed exactly that, from a
  // git worktree, because `translation/` is git-ignored and a worktree gets only the `*.example.*`
  // files. That is the same trap that produced the drift this command exists to catch.
  if (glossary.length === 0) {
    throw new Error(
      `glossary is empty (${paths.translationConfigDir}/glossary.json) — every check would pass vacuously. ` +
        `Steering config is git-ignored, so a git worktree has only the *.example.* files: run this from the ` +
        `main checkout, or restore the config there (docs/ko/setup/steering.md). Never \`pnpm config:init\` to ` +
        `fix this — it writes empty skeletons over the real glossary.`,
    );
  }

  const selected = all
    .filter((t) => (wantStatus ? t.status === wantStatus : true))
    .filter((t) => (since ? (t.approvedAt ?? t.translatedAt) >= since : true));

  const misses: GlossaryMiss[] = selected.flatMap((t) => checkGlossary(t, glossary));

  console.log(`\nchecked ${selected.length} translation(s) against ${glossary.length} glossary entries.\n`);

  if (misses.length === 0) {
    console.log("no drift found.");
  } else {
    // Grouped by item, because the unit a reviewer opens is an item, not a term.
    const byItem = new Map<string, GlossaryMiss[]>();
    for (const m of misses) byItem.set(m.itemId, [...(byItem.get(m.itemId) ?? []), m]);
    console.log(`${misses.length} possible drift(s) across ${byItem.size} item(s):`);
    for (const [itemId, ms] of byItem) {
      console.log(`\n  ${itemId}`);
      for (const m of ms) console.log(`    "${m.term}" → expected ${m.expected}`);
    }
    console.log(`\nNot every line is a defect — a term inside a quoted English sentence, or a rephrasing`);
    console.log(`that drops the noun, will show up here. Read them; do not batch-apply them.`);
  }
} finally {
  await db.close();
}
