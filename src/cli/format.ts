import "./registerErrorHandler";
import { argValue, parseList } from "./args";
// src/cli/format.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { FormatVariants, type FormatSelector } from "../app/FormatVariants";
import { PrepareRefinements } from "../app/PrepareRefinements";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { ALL_CHANNELS, type Channel, type FormatOptions } from "../domain/formatting/models";

const selector: FormatSelector = {};
const ids = parseList(argValue("--ids"));
if (ids) selector.ids = ids;
const typesArg = parseList(argValue("--types"));
if (typesArg) {
  const invalid = typesArg.filter((t) => !ALL_TYPES.includes(t as ConversionType));
  if (invalid.length > 0) throw new Error(`Invalid --types: ${invalid.join(", ")} (allowed: ${ALL_TYPES.join(", ")})`);
  selector.types = typesArg as ConversionType[];
}
const channelsArg = parseList(argValue("--channels"));
if (channelsArg) {
  const invalid = channelsArg.filter((c) => !ALL_CHANNELS.includes(c as Channel));
  if (invalid.length > 0) throw new Error(`Invalid --channels: ${invalid.join(", ")} (allowed: ${ALL_CHANNELS.join(", ")})`);
  selector.channels = channelsArg as Channel[];
}
const opts: FormatOptions = argValue("--x-bold") === "unicode" ? { xBold: "unicode" } : {};
const refine = process.argv.includes("--refine");

const conversionStore = new JsonConversionStore("output/variants");

if (refine) {
  const { worksheet, pending } = await new PrepareRefinements(conversionStore, opts).run(selector);
  await mkdir("output/formatted/worksheets", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const worksheetPath = join("output/formatted/worksheets", `batch-${stamp}.md`);
  await writeFile(worksheetPath, worksheet, "utf8");
  await writeFile(join("output/formatted", "pending.json"), `${JSON.stringify(pending, null, 2)}\n`, "utf8");
  console.log(`prepared ${pending.length} refinement draft(s) → ${worksheetPath}`);
  console.log("Fill each 보정 section, then run: pnpm format:save --id <id> --type <t> --channel <c> --file <txt>");
} else {
  const { renderings, warnings } = await new FormatVariants(conversionStore, new JsonFormattingStore("output/formatted"), opts).run(selector);
  console.log(`formatted ${renderings.length} rendering(s) → output/formatted/renderings.json`);
  for (const w of warnings) console.log(`  ⚠ ${w.itemId}/${w.type}/${w.channel}: ${w.messages.join("; ")}`);
}
