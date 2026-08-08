import type { VideoBackfillPlan } from "../app/BackfillVideoUrls";

/**
 * The plan a `x:video-backfill` run prints — the same lines whether or not `--yes` was passed.
 *
 * That is the whole reason this is a function of the plan alone: an operator previews, reads these
 * lines, and only then authorises the write, which is worth nothing if the `--yes` run prints
 * something else. There is no mode parameter for it to branch on, so the two cannot drift; the CLI
 * adds its own one-line tail after these to say whether it wrote.
 */
export function videoBackfillPlanLines(plan: VideoBackfillPlan): string[] {
  if (plan.candidates === 0) {
    return ["no video media are missing a playable mp4 — nothing to fill."];
  }

  const lines = [
    `${plan.candidates} video media with no playable mp4, in ${plan.candidateThreads} thread(s).`,
    `the API can fill ${plan.filled} of them — ${plan.patched.length} thread(s) would change.`,
  ];

  if (plan.unfilledTweetIds.length > 0) {
    // One line per id, not a count: these are the posts a human may have to chase by hand (a
    // deleted post, or one whose payload genuinely carries no mp4), and a count names none of them.
    // They stay candidates, so every later run reports them again — that is a standing list to
    // read, not a retry loop, and nothing here retries them within a run.
    lines.push(`could not fill (${plan.unfilledTweetIds.length}) — these stay candidates for later runs:`);
    for (const id of plan.unfilledTweetIds) lines.push(`  ${id}`);
  }

  return lines;
}
