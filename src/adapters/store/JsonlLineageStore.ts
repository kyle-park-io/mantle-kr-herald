import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LineageEntry } from "../../domain/lineage/models";
import type { LineageStore, LineageSummary } from "../../ports/LineageStore";

// itemIds are "<source>:<id>" — only the source separator is a ':'. Replace it for a safe filename.
const safeName = (itemId: string) => `${itemId.replace(/:/g, "_")}.jsonl`;

function parseLines(raw: string): LineageEntry[] {
  const out: LineageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LineageEntry);
    } catch {
      console.warn(`[lineage] skipping malformed line`);
    }
  }
  return out;
}

export class JsonlLineageStore implements LineageStore {
  constructor(private readonly dir: string) {}

  async append(entry: LineageEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, safeName(entry.itemId)), JSON.stringify(entry) + "\n", "utf8");
  }

  async load(itemId: string): Promise<LineageEntry[]> {
    try {
      return parseLines(await readFile(join(this.dir, safeName(itemId)), "utf8"));
    } catch {
      return [];
    }
  }

  async listItems(): Promise<LineageSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: LineageSummary[] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      // Reconstruct the real itemId from the entries (avoids ambiguous '_' -> ':' reversal).
      const entries = parseLines(await readFile(join(this.dir, f), "utf8"));
      if (entries.length === 0) continue;
      out.push({ itemId: entries[0].itemId, entries: entries.length, lastStage: entries[entries.length - 1].stage });
    }
    return out;
  }
}
