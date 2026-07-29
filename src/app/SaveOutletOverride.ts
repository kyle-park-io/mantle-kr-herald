import { toCanonical } from "../domain/formatting/canonical";
import { overrideKey, type OutletOverride } from "../domain/outlet/override";
import { outletById } from "../domain/outlet/models";
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
 */
export class SaveOutletOverride {
  constructor(
    private readonly store: OutletOverrideStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: SaveOutletOverrideInput): Promise<OutletOverride | undefined> {
    if (!outletById(input.outletId)) throw new Error(`unknown outlet: ${input.outletId}`);
    const key = overrideKey(input);

    if (input.revert) {
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
    return saved;
  }
}
