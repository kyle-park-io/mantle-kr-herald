import "./registerErrorHandler";
import { argValue, parseList } from "./args";
// src/cli/convert-prepare.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { FileTranslationConfig } from "../adapters/store/FileTranslationConfig";
import { FileConversionConfig } from "../adapters/store/FileConversionConfig";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonTypedFewShotStore } from "../adapters/store/JsonTypedFewShotStore";
import { PrepareConversions, type ConversionSelector } from "../app/PrepareConversions";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import type { FewShotStore } from "../ports/FewShotStore";

const selector: ConversionSelector = {};
const ids = parseList(argValue("--ids"));
if (ids) selector.ids = ids;
const since = argValue("--since");
if (since) selector.since = since;
const limit = argValue("--limit");
if (limit) {
  const n = Number(limit);
  if (Number.isFinite(n)) selector.limit = n;
}
const typesArg = parseList(argValue("--types"));
if (typesArg) {
  const invalid = typesArg.filter((t) => !ALL_TYPES.includes(t as ConversionType));
  if (invalid.length > 0) throw new Error(`Invalid --types: ${invalid.join(", ")} (allowed: ${ALL_TYPES.join(", ")})`);
  selector.types = typesArg as ConversionType[];
}

const fewShotByType: Record<ConversionType, FewShotStore> = {
  x: new JsonTypedFewShotStore("conversion", "x"),
  kol: new JsonTypedFewShotStore("conversion", "kol"),
  pr: new JsonTypedFewShotStore("conversion", "pr"),
};

const usecase = new PrepareConversions(
  new JsonTranslationStore("output/translations"),
  new JsonGlossaryStore("translation"),
  new FileTranslationConfig("translation"),
  new FileConversionConfig("conversion"),
  fewShotByType,
  new JsonConversionStore("output/variants"),
);

const { worksheet, pending } = await usecase.run(selector);

await mkdir("output/variants/worksheets", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const worksheetPath = join("output/variants/worksheets", `batch-${stamp}.md`);
await writeFile(worksheetPath, worksheet, "utf8");
await writeFile(join("output/variants", "pending.json"), `${JSON.stringify(pending, null, 2)}\n`, "utf8");

console.log(`prepared ${pending.length} variant(s) → ${worksheetPath}`);
console.log("Fill each 변환 section, then run: pnpm convert:save --id <id> --type <x|kol|pr> --file <ko.txt> [--approve]");
