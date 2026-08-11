import { join } from "node:path";
import type { GlossaryDismissal } from "../../domain/translation/models";
import { readJsonFile } from "../../shared/store/jsonFile";

/**
 * `translation/glossary-dismissed.json` — the candidates a human has already said no to.
 *
 * Read-only, unlike `JsonGlossaryStore` next to it, and that is the design rather than an omission:
 * nothing in the pipeline may add a dismissal. A dismissal is a human overruling the evidence, so the
 * only writer is a person with an editor, the same way `style-guide.md` has no `add` command. A
 * `glossary dismiss` subcommand would let an automated run silence its own findings, which is the one
 * way this file could stop being trustworthy.
 *
 * Missing file → `[]` (`readJsonFile`'s ENOENT fallback), because "nothing dismissed yet" is the
 * ordinary state of a fresh checkout and must not be an error. It IS steering config, though —
 * `isSteeringConfigFile` (src/domain/config/steering.ts) accepts the name, so `config:push`,
 * `config:pull` and `deploy:freeze` all carry it, and losing it would silently un-dismiss everything.
 */
export class JsonGlossaryDismissalStore {
  private readonly path: string;
  constructor(dir: string) {
    this.path = join(dir, "glossary-dismissed.json");
  }
  /**
   * REFUSES a file that parses as something other than an array, rather than degrading to "nothing
   * dismissed" — the opposite of how `glossary:mine` treats a malformed reference corpus, and the
   * asymmetry is deliberate.
   *
   * This is the one input a human types by hand, and `{}` instead of `[]` is the obvious slip.
   * `readJsonFile`'s cast would hand that back as an empty-looking `GlossaryDismissal[]`, which means
   * every candidate somebody already rejected returns to Monday's alert — the exact flood this file
   * exists to prevent, arriving silently and looking like the file simply does not work. A failed unit
   * saying "your dismissal file is the wrong shape" is a far better Monday.
   */
  async load(): Promise<GlossaryDismissal[]> {
    const parsed = await readJsonFile<unknown>(this.path, []);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `${this.path} must be a JSON array of { "term": "…" } objects. Refusing rather than reading it ` +
          `as "nothing dismissed", which would put every rejected glossary candidate back in the next alert.`,
      );
    }
    return parsed as GlossaryDismissal[];
  }
}
