export interface WatermarkStore {
  /** Last collected point (ISO time), or undefined if never run. */
  get(): Promise<string | undefined>;
  set(time: string): Promise<void>;
}
