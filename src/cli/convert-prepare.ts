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
import { paths } from "../paths";

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
  x: new JsonTypedFewShotStore(paths.conversionConfigDir, "x"),
  kol: new JsonTypedFewShotStore(paths.conversionConfigDir, "kol"),
  pr: new JsonTypedFewShotStore(paths.conversionConfigDir, "pr"),
};

const usecase = new PrepareConversions(
  new JsonTranslationStore(paths.translationsDir),
  new JsonGlossaryStore(paths.translationConfigDir),
  new FileTranslationConfig(paths.translationConfigDir),
  new FileConversionConfig(paths.conversionConfigDir),
  fewShotByType,
  new JsonConversionStore(paths.variantsDir),
);

const { worksheet, pending } = await usecase.run(selector);

await mkdir(paths.variantsWorksheets, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const worksheetPath = join(paths.variantsWorksheets, `batch-${stamp}.md`);
await writeFile(worksheetPath, worksheet, "utf8");
await writeFile(paths.variantsPending, `${JSON.stringify(pending, null, 2)}\n`, "utf8");

console.log(`prepared ${pending.length} variant(s) → ${worksheetPath}`);
console.log("Fill each 변환 section, then run: pnpm convert:save --id <id> --type <x|kol|pr> --file <ko.txt> [--approve]");
