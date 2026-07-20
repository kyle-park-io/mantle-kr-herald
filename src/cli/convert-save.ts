import "./registerErrorHandler";
import { argValue } from "./args";
// src/cli/convert-save.ts
import { readFile } from "node:fs/promises";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { fewShotStoresByType } from "../adapters/store/JsonTypedFewShotStore";
import { SaveConversion } from "../app/SaveConversion";
import { readJsonFile } from "../shared/store/jsonFile";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import type { PendingVariant } from "../app/PrepareConversions";
import { paths } from "../paths";

const id = argValue("--id");
const type = argValue("--type") as ConversionType | undefined;
const file = argValue("--file");
const approve = process.argv.includes("--approve");
if (!id || !type || !file || !ALL_TYPES.includes(type)) {
  throw new Error("Usage: pnpm convert:save --id <itemId> --type <x|kol|pr> --file <ko.txt> [--approve]");
}

const conversionStore = new JsonConversionStore(paths.variantsDir);

const pending = await readJsonFile<PendingVariant[]>(paths.variantsPending, []);
let sourceKorean = pending.find((p) => p.itemId === id && p.type === type)?.sourceKorean;
if (sourceKorean === undefined) {
  // Not in the current worksheet batch — fall back to an already-saved variant, so you
  // can re-approve a "converted" variant after pending.json was overwritten by a later prepare.
  const existing = (await conversionStore.loadAll()).find((v) => v.itemId === id && v.type === type);
  if (!existing) {
    throw new Error(`Variant ${id}/${type} not found in ${paths.variantsDir} (run convert:prepare first)`);
  }
  sourceKorean = existing.sourceKorean;
}

const convertedText = (await readFile(file, "utf8")).trim();

const fewShotByType = fewShotStoresByType(paths.conversionConfigDir);

const usecase = new SaveConversion(conversionStore, fewShotByType);
const res = await usecase.run({ itemId: id, type, sourceKorean, convertedText, approve });

console.log(`saved ${res.itemId}/${res.type}${res.promoted ? " (approved → few-shot)" : ""}`);
