export interface PublishStore {
  /** Set of "<itemId>:<status>:<drive>" keys already uploaded. */
  listPublished(): Promise<Set<string>>;
  record(key: string): Promise<void>;
}
