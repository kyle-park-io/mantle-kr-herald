import type { ConfigFile } from "../domain/config/bundle";

export interface ConfigFileStore {
  list(): Promise<ConfigFile[]>;
  write(path: string, content: string): Promise<void>;
  backup(destDir: string): Promise<void>;
}
