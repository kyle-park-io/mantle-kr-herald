import type { LineageEntry } from "./models";

// A minimal, order-independent line diff: lines present in one side only. Enough to show a
// single-line revision (e.g. 뎁스 → 유동성) without pulling in a diff library (zod-only).
function diffContent(prev: string, cur: string): string {
  const p = new Set(prev.split("\n"));
  const c = new Set(cur.split("\n"));
  const removed = [...p].filter((l) => l.trim() && !c.has(l)).map((l) => `  - ${l}`);
  const added = [...c].filter((l) => l.trim() && !p.has(l)).map((l) => `  + ${l}`);
  const body = [...removed, ...added].join("\n");
  return body || "  (내용 동일)";
}

export function renderLineage(entries: LineageEntry[]): string {
  const out: string[] = [];
  const prevByKey = new Map<string, LineageEntry>();
  for (const e of entries) {
    const key = `${e.stage}|${e.variant ?? ""}`;
    const prev = prevByKey.get(key);
    const variant = e.variant ? `(${e.variant})` : "";
    const status = e.status ? ` [${e.status}]` : "";
    out.push(`── ${e.at} · ${e.stage}${variant}${status}`);
    if (e.stage === "translated" && !prev && e.sourceText) out.push("원문:", e.sourceText);
    /**
     * A `reverted` entry records a *removal*, so its content is the text that was thrown away — and
     * that text is normally byte-identical to the entry before it, which a diff renders as
     * `(내용 동일)`: the one moment a text was destroyed, shown as a no-op. Print it in full instead.
     * Recovering a reverted room's copy is meant to be a copy-paste out of this output, and after a
     * few revisions reconstructing it from a chain of diffs is exactly the kind of near-miss that
     * puts the wrong words in a live room.
     */
    const removal = e.status === "reverted";
    if (!prev || removal) {
      out.push(removal ? "버린 내용:" : "내용:", e.content);
    } else {
      out.push("변경:", diffContent(prev.content, e.content));
    }
    if (prev && prev.status !== e.status) out.push(`상태: ${prev.status ?? "-"} → ${e.status ?? "-"}`);
    out.push("");
    prevByKey.set(key, e);
  }
  return out.join("\n");
}
