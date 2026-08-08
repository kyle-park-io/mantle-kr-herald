import "./registerErrorHandler";
import { argValue, parseList } from "./args";
// src/cli/format.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { FormatVariants, type FormatSelector } from "../app/FormatVariants";
import { PrepareRefinements } from "../app/PrepareRefinements";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { ALL_CHANNELS, type Channel } from "../domain/formatting/models";
import { archiveFile } from "../shared/store/archive";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
import { loadXMaxWeighted, loadDbConfig } from "../config";
import {
  ONLY_MISSING_FLAG,
  NOTHING_TO_FORMAT_LINE,
  formattedRenderingsLine,
  formatWarningLine,
  skippedPostedLine,
} from "./formatLines";
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

/**
 * Opt-in, and it stays opt-in: without it this command rebuilds every rendering it selects, which
 * is what `[포맷 다시]` and a hand `pnpm format --ids …` after a re-saved conversion are for
 * (docs/ko/review.md spells out that it discards the saved text and the approval). Flipping the
 * default would break both, so the caller that must not overwrite — `src/app/ConvertTick.ts`, on a
 * 30-minute timer — is the one that asks.
 */
const onlyMissing = process.argv.includes(ONLY_MISSING_FLAG);

// `--refine` prepares a worksheet for an agent to *improve* existing renderings; it writes no
// rendering at all, so there is nothing for "only the missing ones" to mean there. Refused rather
// than ignored: a flag that is accepted and does nothing is how a caller ends up believing a run was
// scoped when it was not.
if (onlyMissing && refine) {
  throw new Error(`${ONLY_MISSING_FLAG} does not apply to --refine: that mode prepares a refinement worksheet and writes no renderings.`);
}

const xMaxWeighted = loadXMaxWeighted();

const db = createDb(loadDbConfig());
try {
  const stores = createStores(db);
  const conversionStore = stores.conversionStore;

  if (refine) {
    const { worksheet, pending } = await new PrepareRefinements(
      conversionStore,
      new JsonGlossaryStore(paths.translationConfigDir),
      xMaxWeighted,
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
    const { renderings, warnings, skippedPosted } = await new FormatVariants(
      conversionStore,
      stores.formattingStore,
      stores.translationStore,
      undefined,
      xMaxWeighted,
    ).run(selector, { onlyMissing });
    // Every shape comes from src/cli/formatLines.ts, not from a template literal here:
    // `src/app/ConvertTick.ts` parses this first line on every scheduled fire and fails the tick on
    // anything it does not recognise, so the wording is a contract with another process. See that
    // module's own comment.
    console.log(renderings.length > 0 ? formattedRenderingsLine(renderings.length) : NOTHING_TO_FORMAT_LINE);
    // Under the summary it qualifies, and ahead of the warnings: those are about text this run
    // wrote, and this is about text it deliberately did not.
    if (skippedPosted.length > 0) console.log(skippedPostedLine(skippedPosted.length));
    for (const w of warnings) console.log(formatWarningLine(w));
  }
} finally {
  await db.close();
}
