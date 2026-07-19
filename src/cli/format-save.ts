import "./registerErrorHandler";
import { argValue } from "./args";
// src/cli/format-save.ts
import { readFile } from "node:fs/promises";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { SaveRendering } from "../app/SaveRendering";
import { readJsonFile } from "../shared/store/jsonFile";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { ALL_CHANNELS, type Channel } from "../domain/formatting/models";
import type { PendingRendering } from "../app/PrepareRefinements";
import { paths } from "../paths";

const id = argValue("--id");
const type = argValue("--type") as ConversionType | undefined;
const channel = argValue("--channel") as Channel | undefined;
const file = argValue("--file");
if (!id || !type || !channel || !file || !ALL_TYPES.includes(type) || !ALL_CHANNELS.includes(channel)) {
  throw new Error("Usage: pnpm format:save --id <itemId> --type <x|kol|pr> --channel <x|telegram|kakao|pr_mail> --file <txt>");
}

const pending = await readJsonFile<PendingRendering[]>(paths.formattedPending, []);
const match = pending.find((p) => p.itemId === id && p.type === type && p.channel === channel);
if (!match) {
  throw new Error(`Rendering ${id}/${type}/${channel} not found in output/formatted/pending.json (run format --refine first)`);
}

const text = (await readFile(file, "utf8")).trim();
const res = await new SaveRendering(new JsonFormattingStore(paths.formattedDir)).run({ itemId: match.itemId, type: match.type, channel: match.channel, text });
console.log(`saved ${res.itemId}/${res.type}/${res.channel} (refined)`);
