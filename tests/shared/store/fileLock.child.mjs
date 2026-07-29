import { access, readFile, writeFile } from "node:fs/promises";
import { withFileLock } from "../../../src/shared/store/fileLock.ts";

// A real second process contending for the same ledger — the shape of `pnpm send:channels` running
// while the dashboard `pnpm serve` is up. Two serializers, one file: without a cross-process lock
// both children read the same array and the second write discards the first one's row.
const [, , path, value, peer] = process.argv;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

// Barrier: line both children up before either touches the ledger. Process start-up jitter
// (module loading through tsx) dwarfs the artificial delay below, so without this the "loser"
// could reliably start after the winner had already written — and an unlocked implementation
// would pass by accident. This must stay OUTSIDE the lock: waiting for the peer while holding
// the lock would deadlock the peer out of ever signalling.
await writeFile(`${path}.ready-${value}`, "");
while (!(await exists(`${path}.ready-${peer}`))) await sleep(5);

await withFileLock(path, async () => {
  const current = JSON.parse(await readFile(path, "utf8").catch(() => "[]"));
  // Widen the race window so an unlocked implementation reliably loses a row.
  await sleep(250);
  await writeFile(path, JSON.stringify([...current, value]));
});
