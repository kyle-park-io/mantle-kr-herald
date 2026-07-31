import type { Db } from "../adapters/db/Db";
import type { ConversionType } from "../domain/conversion/models";
import type { TranslationStore } from "../ports/TranslationStore";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FormattingStore } from "../ports/FormattingStore";
import type { OutletOverrideStore } from "../ports/OutletOverrideStore";
import type { DeliveryLedger } from "../ports/DeliveryLedger";
import type { XArticleLedger } from "../ports/XArticleLedger";
import type { PublishStore } from "../ports/PublishStore";
import type { LineageStore } from "../ports/LineageStore";
import type { FewShotStore } from "../ports/FewShotStore";
import type { CollectionRepository } from "../ports/CollectionRepository";
import type { LarkRepository } from "../ports/LarkRepository";
import type { ContentSource } from "../ports/ContentSource";
import { PgTranslationStore } from "../adapters/store/PgTranslationStore";
import { PgConversionStore } from "../adapters/store/PgConversionStore";
import { PgFormattingStore } from "../adapters/store/PgFormattingStore";
import { PgOutletOverrideStore } from "../adapters/store/PgOutletOverrideStore";
import { PgDeliveryLedger } from "../adapters/store/PgDeliveryLedger";
import { PgXArticleLedger } from "../adapters/store/PgXArticleLedger";
import { PgPublishStore } from "../adapters/store/PgPublishStore";
import { PgLineageStore } from "../adapters/store/PgLineageStore";
import { PgFewShotStore, fewShotStoresByType } from "../adapters/store/PgFewShotStore";
import { PgCollectionRepository } from "../adapters/store/PgCollectionRepository";
import { PgLarkRepository } from "../adapters/store/PgLarkRepository";
import { PgContentSource, PgXContentSource, PgLarkContentSource } from "../adapters/store/PgContentSource";

/**
 * The full set of `Pg*` stores a live command (`serve.ts`, or any one-shot CLI entry point) reads
 * or writes through, built once per `db`. Every command that used to `new Json*Store(paths.*)` now
 * does `createStores(db).xxx` instead — one shared construction site rather than each of the twenty
 * entry points repeating the same eleven-store wiring.
 *
 * `db-export.ts` is the one deliberate exception: its whole job is to write the `Json*` files back
 * out, so it keeps constructing `Json*` stores directly rather than going through this module.
 *
 * What is deliberately NOT here, because it stays file-backed (see the plan's carried-forward
 * notes and `stateFiles.ts`'s own doc comment):
 * - `LocalJsonStore`'s `WatermarkStore` half (`x/state.json`) and `LarkLocalStore`'s equivalent
 *   (`lark/state.json`) — `collect`/`collect-lark` are local jobs; only their `CollectionRepository`/
 *   `LarkRepository` half moved to Postgres.
 * - `JsonGlossaryStore`, `FileTranslationConfig`, `FileConversionConfig`, and the `tm.json`-scoped
 *   `JsonFewShotStore` — steering config and the translation-memory precedent corpus, synced by
 *   `config:push`/`config:pull`, never part of the eleven-store "What moves" table.
 * - `JsonCollectionRunLedger` — the collect run log (`x/runs.json`), an operational record of collect
 *   itself, not reviewed pipeline content.
 */
export interface Stores {
  translationStore: TranslationStore;
  conversionStore: ConversionStore;
  formattingStore: FormattingStore;
  overrideStore: OutletOverrideStore;
  deliveryLedger: DeliveryLedger;
  xArticleLedger: XArticleLedger;
  publishStore: PublishStore;
  lineageStore: LineageStore;
  /** Translation-scope few-shot corpus (`few_shot_examples` where `scope = 'translation'`) —
   *  replaces `new JsonFewShotStore(paths.translationConfigDir)` (i.e. `translation/few-shot.json`).
   *  Not `tm.json`: that corpus stays out of Postgres scope — see the module doc comment above. */
  fewShotStore: FewShotStore;
  /** One store per conversion type — replaces `fewShotStoresByType(paths.conversionConfigDir)`
   *  (`JsonTypedFewShotStore`'s per-type `conversion/few-shot.<type>.json` files). */
  fewShotStoresByType: Record<ConversionType, FewShotStore>;
  collectionRepository: CollectionRepository;
  larkRepository: LarkRepository;
  /** X items + Lark items combined, X first — replaces
   *  `new CompositeContentSource([new XContentSource(...), new LarkContentSource(...)])`. */
  contentSource: ContentSource;
  /** X items only — replaces a bare `new XContentSource(paths.xItems)` where a caller (only
   *  `translate-prepare.ts`'s `--source x`) needs just the one source. */
  xContentSource: ContentSource;
  /** Lark items only — the `--source lark` counterpart to `xContentSource` above. */
  larkContentSource: ContentSource;
}

export function createStores(db: Db): Stores {
  return {
    translationStore: new PgTranslationStore(db),
    conversionStore: new PgConversionStore(db),
    formattingStore: new PgFormattingStore(db),
    overrideStore: new PgOutletOverrideStore(db),
    deliveryLedger: new PgDeliveryLedger(db),
    xArticleLedger: new PgXArticleLedger(db),
    publishStore: new PgPublishStore(db),
    lineageStore: new PgLineageStore(db),
    fewShotStore: new PgFewShotStore(db, "translation"),
    fewShotStoresByType: fewShotStoresByType(db),
    collectionRepository: new PgCollectionRepository(db),
    larkRepository: new PgLarkRepository(db),
    contentSource: new PgContentSource(db),
    xContentSource: new PgXContentSource(db),
    larkContentSource: new PgLarkContentSource(db),
  };
}
