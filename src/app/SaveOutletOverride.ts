import { toCanonical } from "../domain/formatting/canonical";
import { overrideKey, type OutletOverride } from "../domain/outlet/override";
import { outletById } from "../domain/outlet/models";
import type { LineageStore } from "../ports/LineageStore";
import type { OutletOverrideStore } from "../ports/OutletOverrideStore";

export interface SaveOutletOverrideInput {
  itemId: string;
  type: string;
  outletId: string;
  text?: string;
  approve?: boolean;
  /** Deletes the override so the room falls back to the group text and the group's approval. */
  revert?: boolean;
}

/**
 * Editing a room forks it; approving marks that fork reviewed; reverting un-forks it.
 * A fresh fork starts at `rendered` even when the group was approved — the text was just changed,
 * so it has not been reviewed in that form. Mirrors the existing rendering-edit rule.
 *
 * Every one of those three moments is also appended to the lineage, because `overrides.json` is the
 * only place a fork's text is written down: `format` regenerates the group text, not the reviewer's
 * per-room edit, so a lost row is a lost text. The lineage is a record, not a rollback — nothing
 * here re-creates a reverted fork.
 */
export class SaveOutletOverride {
  constructor(
    private readonly store: OutletOverrideStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly lineage?: LineageStore,
  ) {}

  async run(input: SaveOutletOverrideInput): Promise<OutletOverride | undefined> {
    if (!outletById(input.outletId)) throw new Error(`unknown outlet: ${input.outletId}`);
    const key = overrideKey(input);

    if (input.revert) {
      /**
       * The one moment a fork can vanish. This branch used to call `remove` having read nothing, so
       * `그룹 글로 되돌리기` destroyed the only copy of the text from a single click, with no
       * confirmation and no error — the read below exists entirely to keep that copy.
       *
       * It runs *before* the remove, which is where this deviates from the other capture sites
       * (they append after their upsert). Everywhere else a swallowed append costs only history,
       * because the text survives in the store either way; here it would cost the text itself. The
       * trade is an entry describing a revert that a failing `remove` then did not perform —
       * readable and harmless next to losing the copy.
       */
      await this.captureRevert(input, key);
      await this.store.remove(key);
      return undefined;
    }

    const existing = (await this.store.loadAll()).find((o) => overrideKey(o) === key);
    const at = this.now();

    if (input.approve !== undefined) {
      const verb = input.approve ? "approve" : "unapprove";
      if (!existing) throw new Error(`${key} has no override to ${verb} — the group carries this room's approval`);
      const updated: OutletOverride = input.approve
        ? { ...existing, status: "approved", approvedAt: at }
        : { ...existing, status: "rendered", approvedAt: undefined };
      await this.store.upsert(updated);
      // Mirrors `ApproveRendering`: the text is unchanged, so this entry is here to make the status
      // transition visible in `pnpm lineage` rather than to record a new version.
      await this.appendFork(input, updated.text, updated.status, at);
      return updated;
    }

    if (input.text === undefined) throw new Error(`${key}: nothing to save`);
    /**
     * Canonicalised exactly like the group's text in `SaveRendering`.
     *
     * Without this a fork was the one text on the board stored raw, and the emitters read it as
     * literally as it was typed: a `---` a reviewer wrote to split a thread stayed in the tweet and
     * the split never happened — one long post carrying a stray separator into a live room, while
     * the identical edit on the group card came out as two.
     */
    const saved: OutletOverride = {
      itemId: input.itemId, type: input.type, outletId: input.outletId,
      text: toCanonical(input.text), status: "rendered", createdAt: existing?.createdAt ?? at,
    };
    await this.store.upsert(saved);
    // `at`, not `saved.createdAt`: an edited fork keeps its original `createdAt`, and stamping the
    // entry with it would file every later revision under the moment the room first forked.
    await this.appendFork(input, saved.text, saved.status, at);
    return saved;
  }

  /**
   * Best-effort, exactly like the other capture sites: an absent store is a no-op and a failure is
   * swallowed, so lineage can never change a save's outcome or throw.
   */
  private async appendFork(input: SaveOutletOverrideInput, content: string, status: string, at: string): Promise<void> {
    if (!this.lineage) return;
    try {
      // `<type>/<outletId>` — the group's `<type>/<channel>` shape, one axis over. A room's history
      // then diffs against its own previous version, not against the group it diverged from.
      await this.lineage.append({ itemId: input.itemId, stage: "forked", variant: `${input.type}/${input.outletId}`, content, status, at });
    } catch (err) {
      console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
    }
  }

  /** Reads the fork about to be discarded. Wrapped like the append: before this, revert read nothing at all, so a failing read must not turn a working revert into an error. */
  private async captureRevert(input: SaveOutletOverrideInput, key: string): Promise<void> {
    if (!this.lineage) return;
    let discarded: OutletOverride | undefined;
    try {
      discarded = (await this.store.loadAll()).find((o) => overrideKey(o) === key);
    } catch (err) {
      console.warn(`[lineage] read before revert failed for ${input.itemId}: ${(err as Error).message}`);
      return;
    }
    if (!discarded) return; // The room was never forked: nothing is removed, so nothing is recorded.
    /**
     * `"reverted"`, not the record's own status. The discarded text is usually identical to the last
     * `forked` entry, and the viewer prints `(내용 동일)` for that — so carrying the record's status
     * would make the single entry that matters most read as a no-op. This makes the viewer's own
     * `상태:` line say what happened, without touching the viewer.
     */
    await this.appendFork(input, discarded.text, "reverted", this.now());
  }
}
