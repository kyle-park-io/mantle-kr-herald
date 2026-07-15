import "./registerErrorHandler";
import { argValue } from "./args";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import type { GlossaryRule } from "../domain/translation/models";

const store = new JsonGlossaryStore("translation");
const command = process.argv[2];

if (command === "add") {
  const term = argValue("--term");
  const ruleArg = argValue("--rule");
  const validRules: GlossaryRule[] = ["translate", "transliterate", "keep"];
  if (!term || !ruleArg || !validRules.includes(ruleArg as GlossaryRule)) {
    throw new Error('Usage: pnpm glossary add --term <term> --rule <translate|transliterate|keep> [--target <ko>] [--note <n>] [--source <url>]');
  }
  const rule = ruleArg as GlossaryRule; // validated above
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
