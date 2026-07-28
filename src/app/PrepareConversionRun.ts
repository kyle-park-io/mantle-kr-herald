import type { ConversionType } from "../domain/conversion/models";
import type { PendingVariant, PrepareConversions } from "./PrepareConversions";

/**
 * Runs `convert:prepare` on behalf of the dashboard. The board stops here on purpose: filling the
 * worksheet is the local agent's job (no Claude API in this tool), so the button prepares the work
 * and the operator asks the agent to complete it.
 *
 * Also persists the pending batch (`savePending`), mirroring `src/cli/convert-prepare.ts`: the
 * agent's own next step, `pnpm convert:save`, reads `output/variants/pending.json` to find each
 * item's `sourceKorean`. Writing only the worksheet would strand that step for anything not
 * already converted — exactly the item this button exists for.
 */
export class PrepareConversionRun {
  constructor(
    private readonly prepare: PrepareConversions,
    private readonly writeFile: (path: string, body: string) => Promise<void>,
    private readonly worksheetDir: string,
    private readonly stamp: () => string = () => new Date().toISOString().replace(/[:.]/g, "-"),
    private readonly savePending: (pending: PendingVariant[]) => Promise<void> = async () => {},
  ) {}

  async run(input: { itemId: string; types: ConversionType[] }): Promise<{ worksheetPath: string; pending: number }> {
    const { worksheet, pending } = await this.prepare.run({ ids: [input.itemId], types: input.types });
    if (pending.length === 0) return { worksheetPath: "", pending: 0 };
    const worksheetPath = `${this.worksheetDir}/batch-${this.stamp()}.md`;
    await this.writeFile(worksheetPath, worksheet);
    await this.savePending(pending);
    return { worksheetPath, pending: pending.length };
  }
}
