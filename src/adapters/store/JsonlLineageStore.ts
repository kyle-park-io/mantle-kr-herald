import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LineageEntry, LineageEvent } from "../../domain/lineage/models";
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
    const out: LineageSummary[] = [];
    for (const entries of await this.readAll()) {
      // Reconstruct the real itemId from the entries (avoids ambiguous '_' -> ':' reversal).
      out.push({ itemId: entries[0].itemId, entries: entries.length, lastStage: entries[entries.length - 1].stage });
    }
    return out;
  }

  /**
   * Flattened, in `readdir` order — i.e. grouped by item but not chronological across items. The
   * port declares this order unspecified for exactly this reason: there is no cheap way to merge
   * one file per item into one timeline here, and the only caller sorts by date anyway.
   *
   * No projection worth making, unlike `PgLineageStore.listEvents`: the file backend has to read
   * and parse each whole line to reach `at` at all, so the saving would be a few object properties
   * after the cost has already been paid. This backend only serves `db:export` now (see
   * `src/cli/stores.ts`) and never a live rollup.
   */
  async listEvents(): Promise<LineageEvent[]> {
    return (await this.readAll()).flat();
  }

  /** Every file's entries, skipping non-`.jsonl` files and files that parsed to nothing. Returns
   *  `[]` — never throws — when the directory itself does not exist, matching `load()`. */
  private async readAll(): Promise<LineageEntry[][]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: LineageEntry[][] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const entries = parseLines(await readFile(join(this.dir, f), "utf8"));
      if (entries.length === 0) continue;
      out.push(entries);
    }
    return out;
  }
}
