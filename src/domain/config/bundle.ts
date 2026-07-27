import { z } from "zod";

export interface ConfigFile {
  path: string;
  content: string;
}

const BundleSchema = z.object({
  version: z.literal(1),
  pushedAt: z.string(),
  files: z.record(z.string(), z.string()),
});

export function assembleConfigBundle(files: ConfigFile[], now: () => string = () => new Date().toISOString()): string {
  const map: Record<string, string> = {};
  for (const f of files) map[f.path] = f.content;
  return JSON.stringify({ version: 1, pushedAt: now(), files: map }, null, 2);
}

export function parseConfigBundle(json: string): ConfigFile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("downloaded snapshot is not a valid config bundle (not JSON)");
  }
  const parsed = BundleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`downloaded snapshot is not a valid config bundle: ${parsed.error.message}`);
  return Object.entries(parsed.data.files).map(([path, content]) => ({ path, content }));
}
