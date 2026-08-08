import type { SkippedText, TextVideoBackfillPlan } from "../app/BackfillTextVideoUrls";

/** Where a skipped text lives, as one grep-able string. A rendering needs its (type, channel) too:
 *  an item can have six of them and `renderings.text` alone would name none of them. */
function where(s: SkippedText): string {
  return s.column === "renderings.text" ? `renderings.text (${s.type}/${s.channel})` : s.column;
}

/** The reason, said as what to do about it — each of the three has a different remedy. */
function because(s: SkippedText): string {
  switch (s.reason.kind) {
    case "no-thread":
      return `${s.bare} bare marker(s), but no collected thread stands behind this item — nothing to pair them with`;
    case "count-mismatch":
      return (
        `${s.reason.markers} marker(s) in the text vs ${s.reason.videos} video(s) in the thread — ` +
        `nothing says which clip each marker is`
      );
    case "url-missing":
      return (
        `${s.bare} bare marker(s), but ${s.reason.missing} of the thread's own video(s) still has no mp4 — ` +
        `run \`pnpm x:video-backfill\` first, then this again`
      );
  }
}

/**
 * The plan a `text:video-backfill` run prints — the same lines whether or not `--yes` was passed.
 *
 * A function of the plan alone, exactly like `videoBackfillPlanLines` next door and for the same
 * reason: an operator previews, reads these lines, and only then authorises the write, which is
 * worth nothing if the `--yes` run prints something else. No mode parameter means the two cannot
 * drift; the CLI adds its own one-line tail after these to say whether it wrote.
 *
 * Translations and renderings are printed as two sections rather than one row count, because they
 * are two different decisions. Filling a `posted` translation changes what 1차/2차 검수 *display*
 * and nothing else — that post went out long ago. Filling a rendering changes what the next
 * `send:channels` *uploads*, because `SendChannels` attaches only the video markers that carry a
 * url. An operator approving this is choosing between "fix the screens" and "change what goes out",
 * and a combined total would hide which of the two they just agreed to.
 */
export function textVideoBackfillPlanLines(plan: TextVideoBackfillPlan): string[] {
  if (plan.scanned === 0) return ["no stored text carries a bare [영상] — nothing to fill."];

  const rows = plan.translations.length + plan.renderings.length;
  const lines = [
    `${plan.scanned} stored text(s) carry a bare [영상].`,
    `would fill ${plan.filled} marker(s) in ${rows} row(s).`,
  ];

  if (plan.translations.length > 0) {
    const markers = plan.translations.reduce((n, p) => n + p.filled, 0);
    lines.push(
      "",
      `translations — ${plan.translations.length} row(s), ${markers} marker(s).`,
      `what it changes: only what the review screens DISPLAY. Nothing is sent and nothing is re-sent;`,
      `a posted row's live post is untouched, and published_text is never written.`,
    );
    for (const p of plan.translations) {
      lines.push(`  ${p.translation.itemId} · ${p.translation.status} · ${p.columns.join(", ")} · ${p.filled} marker(s)`);
    }
  }

  if (plan.renderings.length > 0) {
    const markers = plan.renderings.reduce((n, p) => n + p.filled, 0);
    lines.push(
      "",
      `renderings — ${plan.renderings.length} row(s), ${markers} marker(s).`,
      `what it changes: what the NEXT send ATTACHES. send:channels uploads only a [영상] marker that`,
      `carries a url, so each row below would go out with a clip it currently goes out without.`,
    );
    for (const p of plan.renderings) {
      const r = p.rendering;
      lines.push(`  ${r.itemId} · ${r.type}/${r.channel} · ${r.status} · ${p.filled} marker(s)`);
    }
  }

  if (plan.skipped.length > 0) {
    // One line per text, not a count. Each of these is a person's job — the alternative is a
    // half-filled text, which reads as finished and would never be looked at again. They stay
    // candidates, so every later run reports them again; nothing here retries them.
    lines.push("", `skipped (${plan.skipped.length}) — left untouched rather than half-filled:`);
    for (const s of plan.skipped) lines.push(`  ${s.itemId} · ${where(s)} · ${because(s)}`);
  }

  return lines;
}
