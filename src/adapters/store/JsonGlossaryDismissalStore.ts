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
  async load(): Promise<GlossaryDismissal[]> {
    return readJsonFile<GlossaryDismissal[]>(this.path, []);
  }
}
