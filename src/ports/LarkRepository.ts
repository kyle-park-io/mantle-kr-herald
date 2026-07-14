import type { LarkMessage } from "../domain/larkMessage";

export interface LarkRepository {
  loadAll(): Promise<LarkMessage[]>;
  /** Merge by messageId (incoming wins). Never drops stored messages. */
  upsert(messages: LarkMessage[]): Promise<void>;
}
