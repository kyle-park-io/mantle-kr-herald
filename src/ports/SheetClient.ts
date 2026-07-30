export interface SheetClient {
  getValues(range: string): Promise<string[][]>;
  appendValues(range: string, rows: string[][]): Promise<void>;
  updateValues(range: string, rows: string[][]): Promise<void>;
  /**
   * Write several disjoint ranges in a **single** API request.
   *
   * The Sheets API allows 60 write requests per minute per user, and one `updateValues` per row does
   * not fit inside that once a month's sweep produces a hundred-plus rows: the run takes a 429
   * partway through and abandons the rest. This exists so a writer can be as narrow as it likes
   * about *which* columns it touches — never one a human owns — without paying an API request per
   * range.
   */
  batchUpdateValues(updates: { range: string; rows: string[][] }[]): Promise<void>;
  createSpreadsheet(title: string, tabs: { title: string }[]): Promise<{ spreadsheetId: string }>;
  /** Create a tab if it does not already exist (no-op when present). */
  ensureTab(title: string): Promise<void>;
}
