import { ALL_TYPES, type ConversionType } from "../conversion/models";

/**
 * The few-shot corpora as operational-state snapshot paths — `translation` plus one per
 * `ALL_TYPES` member, derived rather than listed so a new conversion type needs no wiring here.
 *
 * **Deliberately NOT the `db:export` names.** `translation/few-shot.json` and
 * `conversion/few-shot.<type>.json` already mean something else: they are what `pnpm db:export`
 * writes for the `db:export` → `db:import` rollback path, they sit in the steering directories, and
 * both `config:push` and `deploy:freeze` exclude them by name (`src/domain/config/steering.ts`).
 * Reusing those strings inside a *state* snapshot would collide two different artifacts on one
 * path, and the next person to read a snapshot would have no way to tell which one they had.
 */
export const FEW_SHOT_REL: readonly string[] = [
  "output/few-shot/translation.json",
  ...ALL_TYPES.map((type) => `output/few-shot/conversion.${type}.json`),
];

const TRANSLATION_REL = "output/few-shot/translation.json";
const CONVERSION_REL = /^output\/few-shot\/conversion\.([a-z_]+)\.json$/;

/**
 * The `PgFewShotStore` scope a tracked path restores into, or `undefined` when the path is not one
 * of ours. `undefined` rather than a throw: `DbStateFileStore.write` asks this first and falls
 * through to its own "refusing to restore untracked operational-state file" error, so there is one
 * refusal message rather than two.
 *
 * The conversion branch checks the captured type against `ALL_TYPES` instead of trusting the
 * pattern. The path arrives from a *downloaded* snapshot and is about to select a database scope;
 * an unrecognised type must be refused, not written into a scope no reader will ever look in.
 */
export function fewShotScopeFor(rel: string): string | undefined {
  if (rel === TRANSLATION_REL) return "translation";
  const match = CONVERSION_REL.exec(rel);
  if (!match) return undefined;
  const type = match[1] as ConversionType;
  return ALL_TYPES.includes(type) ? `conversion:${type}` : undefined;
}
