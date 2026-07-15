export interface SheetClient {
  getValues(range: string): Promise<string[][]>;
  appendValues(range: string, rows: string[][]): Promise<void>;
  updateValues(range: string, rows: string[][]): Promise<void>;
  createSpreadsheet(title: string, tabs: { title: string }[]): Promise<{ spreadsheetId: string }>;
}
