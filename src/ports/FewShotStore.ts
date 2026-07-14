import type { FewShotExample } from "../domain/translation/models";

export interface FewShotStore {
  load(): Promise<FewShotExample[]>;
  add(ex: FewShotExample): Promise<void>;
}
