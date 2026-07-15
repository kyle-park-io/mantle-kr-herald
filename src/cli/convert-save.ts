import "./registerErrorHandler";
// src/cli/convert-save.ts
import { readFile } from "node:fs/promises";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonTypedFewShotStore } from "../adapters/store/JsonTypedFewShotStore";
import { SaveConversion } from "../app/SaveConversion";
import { readJsonFile } from "../shared/store/jsonFile";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import type { PendingVariant } from "../app/PrepareConversions";
import type { FewShotStore } from "../ports/FewShotStore";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = argValue("--id");
const type = argValue("--type") as ConversionType | undefined;
const file = argValue("--file");
const approve = process.argv.includes("--approve");
if (!id || !type || !file || !ALL_TYPES.includes(type)) {
  throw new Error("Usage: pnpm convert:save --id <itemId> --type <x|kol|pr> --file <ko.txt> [--approve]");
}

const pending = await readJsonFile<PendingVariant[]>("output/variants/pending.json", []);
const item = pending.find((p) => p.itemId === id && p.type === type);
if (!item) {
  throw new Error(`Variant ${id}/${type} not found in output/variants/pending.json (run convert:prepare first)`);
}

const convertedText = (await readFile(file, "utf8")).trim();

const fewShotByType: Record<ConversionType, FewShotStore> = {
  x: new JsonTypedFewShotStore("conversion", "x"),
  kol: new JsonTypedFewShotStore("conversion", "kol"),
  pr: new JsonTypedFewShotStore("conversion", "pr"),
};

const usecase = new SaveConversion(new JsonConversionStore("output/variants"), fewShotByType);
const res = await usecase.run({ itemId: item.itemId, type: item.type, sourceKorean: item.sourceKorean, convertedText, approve });

console.log(`saved ${res.itemId}/${res.type}${res.promoted ? " (approved → few-shot)" : ""}`);
