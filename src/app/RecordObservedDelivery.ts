import { deliveredToRoom, deliveryKey, type DeliveryEntry } from "../domain/delivery/models";
import type { DeliveryLedger } from "../ports/DeliveryLedger";

/**
 * Writes a `DeliveryEntry` that no bot sent — it was read back off the account and matched to copy
 * we approved (`src/domain/publish/xReconcile.ts`'s `observedDelivery`). This is the one path by
 * which an `auto` outlet (`send:channels`'s outlets — see `src/domain/outlet/models.ts`) gains a
 * delivery row without a bot having sent it, and that is exactly the back door `MarkDelivery`
 * deliberately refuses for a human's `delivered` claim: ticking 전달함 on an auto outlet is rejected
 * there because `send:channels` gates purely on ledger membership, so a planted row would make it
 * look already-sent and the bot would silently skip a post that never actually went out. `record`
 * closes that same door here by accepting only what an observation actually is:
 *
 * - `status` must be `"sent"`. Anything else — most of all `"delivered"` — is a claim, not an
 *   observation, and this class exists so that claims keep going through `MarkDelivery` (which
 *   already refuses them on an auto outlet) rather than through here.
 * - `postId` must be present. `sent` without a `postId` means nothing was actually seen on the
 *   account — a claim wearing an observation's status.
 *
 * Both checks throw, naming the reason, so a caller that builds a bad entry fails loudly rather
 * than silently recording a claim as fact.
 *
 * Idempotent the other way: when the ledger already holds a row for `deliveryKey(entry)` that still
 * means "this room has this copy", `record` returns `"already-recorded"` instead of throwing or
 * writing again. `sent` is never reversed, so the existing row is already the record of what
 * happened — re-writing it could only replace a real send's post id with one a match merely guessed.
 * Returning a value (not throwing) lets the caller (`x-reconcile.ts`, walking a whole plan of
 * confirmed rows) keep going past an already-done row instead of aborting the rest of the plan on it.
 *
 * **A `dropped` row is the one existing row this DOES overwrite, and it says so.** `dropped` means a
 * scheduled Typefully draft was deleted before it published, so nothing ever reached the account —
 * `deliveredToRoom` excludes it from every ledger's `loadKeys()` for exactly that reason, and
 * `send:channels` treats the room as sendable again. A ≥0.95 match against a *live* post is newer and
 * stronger evidence than that row: the copy is on the account now, whoever put it there. Leaving the
 * `dropped` row in place would keep the board saying "never went out" about a post anyone can open,
 * and would leave `send:channels` free to post it a second time. So the overwrite is the right record
 * — but it is returned as its own outcome, `"replaced-dropped"`, and printed as one, rather than
 * being an accident of which predicate `loadKeys()` happens to apply. That accident is what this
 * used to be: the guard read `loadKeys()`, which drops `dropped` rows, and `ledger.add` is an upsert,
 * so the row was silently rewritten to `sent` and reported as `✓ recorded`.
 *
 * The existence check therefore reads `loadAll()` and applies `deliveredToRoom` here, rather than
 * delegating the distinction to `loadKeys()` — the two answers differ, and this class needs both.
 */
export class RecordObservedDelivery {
  constructor(private readonly ledger: DeliveryLedger) {}

  async record(entry: DeliveryEntry): Promise<"written" | "already-recorded" | "replaced-dropped"> {
    if (entry.status !== "sent") {
      throw new Error(
        `RecordObservedDelivery only records an observation (status "sent"), got "${entry.status}" for ` +
          `${entry.itemId}:${entry.type}:${entry.outletId} — a human's "delivered" claim on an auto outlet ` +
          `is MarkDelivery's refusal to make, not this class's to bypass.`,
      );
    }
    if (!entry.postId) {
      throw new Error(
        `RecordObservedDelivery requires postId for ${entry.itemId}:${entry.type}:${entry.outletId} — ` +
          `without it nothing was actually observed on the account.`,
      );
    }

    const key = deliveryKey(entry);
    const existing = (await this.ledger.loadAll()).find((row) => deliveryKey(row) === key);
    if (existing !== undefined && deliveredToRoom(existing)) return "already-recorded";

    await this.ledger.add(entry);
    return existing === undefined ? "written" : "replaced-dropped";
  }
}
