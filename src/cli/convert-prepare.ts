import "./registerErrorHandler";
// src/cli/convert-prepare.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig } from "../config";
import { createStores } from "./stores";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { FileTranslationConfig } from "../adapters/store/FileTranslationConfig";
import { FileConversionConfig } from "../adapters/store/FileConversionConfig";
import { PrepareConversions } from "../app/PrepareConversions";
import { conversionSelectorFrom } from "./convertPrepareSelector";
import { ALL_TYPES } from "../domain/conversion/models";
import { archiveFile } from "../shared/store/archive";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
import { NOTHING_TO_CONVERT_LINE, passthroughVariantsLine, preparedVariantsLine } from "./convertPrepareLines";
import { paths } from "../paths";

// Parsed in its own module so it can be tested — see `conversionSelectorFrom`'s own comment for why
// nothing at this file's top level can be. `--max-variants` in particular is read by the scheduler's
// tick and by nothing else, and it silently stops working if this line stops calling that function.
const selector = conversionSelectorFrom(process.argv);

const db = createDb(loadDbConfig());
try {
  const stores = createStores(db);
  const usecase = new PrepareConversions(
    stores.translationStore,
    new JsonGlossaryStore(paths.translationConfigDir),
    new FileTranslationConfig(paths.translationConfigDir),
    new FileConversionConfig(paths.conversionConfigDir),
    stores.fewShotStoresByType,
    stores.conversionStore,
  );

  const { worksheet, pending, passthrough } = await usecase.run(selector);

  // An empty batch writes nothing at all — no worksheet, no archive, no pending.json — and says so.
  //
  // This used to fall through and write all three unconditionally. That was harmless at the rate a
  // human runs this command and stopped being harmless the moment `herald-convert.timer` started
  // running it 48 times a day: an empty worksheet per fire into a directory nothing prunes, and — far
  // worse than the litter — an `archiveFile` call that *moves* `pending.json` out of the way
  // (`src/shared/store/archive.ts` renames, it does not copy) before replacing it with `[]`. A batch
  // an operator or an agent was midway through saving would be relocated into `output/archive/` by
  // the next scheduled fire, and `convert:save` would then refuse every remaining item in it with
  // "run convert:prepare first".
  //
  // `PrepareConversionRun` (the dashboard's `[변환 준비]` button) already returns before writing
  // anything for the same case, so this is the CLI catching up to a decision the board had made.
  if (pending.length === 0) {
    console.log(NOTHING_TO_CONVERT_LINE);
  } else {
    await mkdir(paths.variantsWorksheets, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const worksheetPath = join(paths.variantsWorksheets, `batch-${stamp}.md`);
    await writeFile(worksheetPath, worksheet, "utf8");

    const archived = await archiveFile(paths.variantsPending, paths.archiveDir, "pending-variants");
    if (archived) console.log(`  archived the previous unsaved batch → ${archived}`);
    await writeJsonFileAtomic(paths.variantsDir, paths.variantsPending, pending);

    // Both lines come from src/cli/convertPrepareLines.ts, not from a template literal here:
    // `src/app/ConvertTick.ts` parses this first line on every scheduled fire and fails the tick on
    // anything it does not recognise, so the wording is a contract with another process. See that
    // module's own comment.
    console.log(preparedVariantsLine(pending.length, worksheetPath));
    console.log(
      `Fill each 변환 section, then run: pnpm convert:save --id <id> --type <${ALL_TYPES.join("|")}> --file <ko.txt>`,
    );
  }
  // Under either branch, never in place of one: the first line is a contract with `ConvertTick`.
  if (passthrough.length > 0) console.log(passthroughVariantsLine(passthrough.length));
} finally {
  await db.close();
}
