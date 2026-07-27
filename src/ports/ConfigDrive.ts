export interface ConfigDrive {
  upload(folderId: string, name: string, content: string): Promise<{ id: string }>;
  latest(folderId: string, prefix: string): Promise<{ id: string; name: string } | undefined>;
  download(fileId: string): Promise<string>;
}
