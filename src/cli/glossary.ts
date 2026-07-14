import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import type { GlossaryRule } from "../domain/translation/models";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const store = new JsonGlossaryStore("data");
const command = process.argv[2];

if (command === "add") {
  const term = argValue("--term");
  const rule = argValue("--rule") as GlossaryRule | undefined;
  if (!term || !rule) {
    throw new Error('Usage: pnpm glossary add --term <term> --rule <translate|transliterate|keep> [--target <ko>] [--note <n>] [--source <url>]');
  }
  await store.upsertEntry({
    term,
    rule,
    target: argValue("--target"),
    note: argValue("--note"),
    source: argValue("--source"),
    updatedAt: new Date().toISOString().slice(0, 10),
  });
  console.log(`glossary: upserted "${term}"`);
} else {
  const all = await store.load();
  console.log(`glossary: ${all.length} entries`);
  for (const e of all) {
    console.log(`  ${e.term} → ${e.rule}${e.target ? ": " + e.target : ""}`);
  }
}
