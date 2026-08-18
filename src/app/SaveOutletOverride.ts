import { toCanonical } from "../domain/formatting/canonical";
import { overrideKey, type OutletOverride } from "../domain/outlet/override";
import { outletById } from "../domain/outlet/models";
import type { LineageStore } from "../ports/LineageStore";
import type { LineageActor } from "../domain/lineage/models";
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
    // Was `lineage?: LineageStore` — dropped to `| undefined` so `actor` below can be required: TS
    // refuses a required parameter after an optional (`?`) one, but accepts one after a parameter
    // typed to allow `undefined`. The call-site behaviour is identical either way.
    private readonly lineage: LineageStore | undefined,
    /**
     * Which kind of caller built this — see `LineageActor`. Required rather than defaulted: a new
     * call site that inherits a neighbour's answer would mislabel human edits as machine ones, and
     * nothing downstream could tell. One value per process; no process is sometimes a human.
     */
    private readonly actor: LineageActor,
  ) {}

  async run(input: SaveOutletOverrideInput): Promise<OutletOverride | undefined> {
    if (!outletById(input.outletId)) throw new Error(`unknown outlet: ${input.outletId}`);
    const key = overrideKey(input);

    if (input.revert) {
      /**
       * The one moment a fork can vanish. This branch used to call `remove` having read nothing, so
       * `그룹 글로 되돌리기` destroyed the only copy of the text from a single click, with no
       * confirmation and no error — the capture below exists entirely to keep that copy.
       *
       * **This is the one capture site in the codebase that is not best-effort, and the difference
       * is deliberate — do not "fix" the inconsistency.** Best-effort exists so that lineage cannot
       * break a save; it is the right rule everywhere the record survives the save, because a lost
       * append there costs only history. Here the record does *not* survive: a swallowed failure
       * followed by an unconditional `remove` would destroy a text that cannot be regenerated,
       * leaving a `console.warn` on a server console nobody is reading while the board reports
       * success. So a failure to record propagates and `remove` never runs — `apiHandlers`' PUT
       * branch turns the throw into a readable 400, and the fork is still there. A revert the
       * operator can retry is worth far more than a fork nobody can get back.
       *
       * Running before the remove also makes the pair crash-safe in the write-ahead sense: a crash
       * between the two loses nothing, because the text is recorded first and still in the store.
       *
       * The reverse partial failure is possible and deliberately tolerated: the capture succeeds,
       * `remove` then fails, and the lineage carries a `reverted` entry for a revert that never
       * happened — a second one if the operator retries. That is harmless, because the lineage is
       * append-only history and the fork is still in the store the entry says it was discarded
       * from. **A stray `reverted` entry beside a live override is this, not a bug.**
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
   * Writes one `forked` entry. An absent store is a no-op; a failure **propagates**, leaving the
   * caller to decide whether it can be lived with. Only the revert path cannot.
   */
  private async writeFork(input: SaveOutletOverrideInput, content: string, status: string, at: string): Promise<void> {
    if (!this.lineage) return;
    // `<type>/<outletId>` — the group's `<type>/<channel>` shape, one axis over. A room's history
    // then diffs against its own previous version, not against the group it diverged from.
    await this.lineage.append({ itemId: input.itemId, stage: "forked", variant: `${input.type}/${input.outletId}`, content, status, at, actor: this.actor });
  }

  /**
   * Best-effort, exactly like the other capture sites (`SaveRendering`, `ApproveRendering`): the
   * failure is swallowed, so lineage can never change a save's outcome or throw. Correct here
   * because the override survives either way — a lost append costs history, not text. The revert
   * path deliberately does **not** use this; see the comment in `run`.
   */
  private async appendFork(input: SaveOutletOverrideInput, content: string, status: string, at: string): Promise<void> {
    try {
      await this.writeFork(input, content, status, at);
    } catch (err) {
      console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
    }
  }

  /**
   * Reads the fork about to be discarded and records it. Nothing here is swallowed: a store that
   * cannot be read and a lineage that cannot be written both mean "no copy exists", and the caller
   * must not go on to delete the only one.
   *
   * Holding the *read* to that rule buys nothing in the deterministic case — the only implementer,
   * `JsonOutletOverrideStore.remove`, re-reads the same file through the same `readJsonFile`, so a
   * read that keeps failing already failed the revert with a byte-identical message. It is the
   * **transient** case this is for: a read that throws once and then succeeds on `remove`'s retry
   * used to delete the fork with no copy anywhere. That is the whole reason the guard is here, and
   * it is not visible from the happy path.
   */
  private async captureRevert(input: SaveOutletOverrideInput, key: string): Promise<void> {
    if (!this.lineage) return;
    const discarded = (await this.store.loadAll()).find((o) => overrideKey(o) === key);
    if (!discarded) return; // The room was never forked: nothing is removed, so nothing is recorded.
    /**
     * `"reverted"`, not the record's own status. The discarded text is usually identical to the last
     * `forked` entry, and the viewer prints `(내용 동일)` for that — so carrying the record's status
     * would make the single entry that matters most read as a no-op. This makes the viewer's own
     * `상태:` line say what happened, without touching the viewer.
     */
    await this.writeFork(input, discarded.text, "reverted", this.now());
  }
}
