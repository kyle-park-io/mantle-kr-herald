import "./registerErrorHandler";
import { argValue, parseList } from "./args";
// src/cli/format.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { FormatVariants, type FormatSelector } from "../app/FormatVariants";
import { PrepareRefinements } from "../app/PrepareRefinements";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { ALL_CHANNELS, type Channel } from "../domain/formatting/models";
import { archiveFile } from "../shared/store/archive";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
import { paths } from "../paths";

if (process.argv.some((a) => a === "--x-bold" || a.startsWith("--x-bold="))) {
  throw new Error(
    "--x-bold was removed. Unicode bold (𝗔) is skipped entirely by screen readers, is not matched " +
      "by X search, and costs 2 weighted characters per letter. Write **bold** in the canonical " +
      "text instead — each destination decides how to spell it.",
  );
}

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
const refine = process.argv.includes("--refine");

const conversionStore = new JsonConversionStore(paths.variantsDir);

if (refine) {
  const { worksheet, pending } = await new PrepareRefinements(
    conversionStore,
    new JsonGlossaryStore(paths.translationConfigDir),
  ).run(selector);
  await mkdir(paths.formattedWorksheets, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const worksheetPath = join(paths.formattedWorksheets, `batch-${stamp}.md`);
  await writeFile(worksheetPath, worksheet, "utf8");

  const archived = await archiveFile(paths.formattedPending, paths.archiveDir, "pending-formatted");
  if (archived) console.log(`  archived the previous unsaved batch → ${archived}`);
  await writeJsonFileAtomic(paths.formattedDir, paths.formattedPending, pending);

  console.log(`prepared ${pending.length} refinement draft(s) → ${worksheetPath}`);
  console.log("Fill each 보정 section, then run: pnpm format:save --id <id> --type <t> --channel <c> --file <txt>");
} else {
  const { renderings, warnings } = await new FormatVariants(conversionStore, new JsonFormattingStore(paths.formattedDir)).run(selector);
  console.log(`formatted ${renderings.length} rendering(s) → ${join(paths.formattedDir, 'renderings.json')}`);
  for (const w of warnings) console.log(`  ⚠ ${w.itemId}/${w.type}/${w.channel}: ${w.messages.join("; ")}`);
}
