import { describe, expect, it } from "vitest";
import { PrepareConversionRun } from "../../src/app/PrepareConversionRun";

describe("PrepareConversionRun", () => {
  it("writes the worksheet for the requested item and types and reports the path", async () => {
    const written: { path: string; body: string }[] = [];
    const prepare = { run: async () => ({ worksheet: "## 유형: 공지", pending: [{ itemId: "x:1", type: "announcement", sourceKorean: "승인" }] }) };
    const uc = new PrepareConversionRun(prepare as never, async (p, b) => { written.push({ path: p, body: b }); }, "/ws", () => "STAMP");

    const res = await uc.run({ itemId: "x:1", types: ["announcement"] });

    expect(res.pending).toBe(1);
    expect(res.worksheetPath).toBe("/ws/batch-STAMP.md");
    expect(written[0]?.body).toContain("## 유형: 공지");
  });

  it("does not write a worksheet when nothing is pending", async () => {
    const written: string[] = [];
    const prepare = { run: async () => ({ worksheet: "", pending: [] }) };
    const uc = new PrepareConversionRun(prepare as never, async (p) => { written.push(p); }, "/ws", () => "STAMP");

    const res = await uc.run({ itemId: "x:1", types: ["announcement"] });

    expect(res.pending).toBe(0);
    expect(written).toEqual([]);
  });

  /**
   * Picking `x` alone leaves `pending` empty — but a variant row was still written, straight from
   * the approved translation. Reporting only `pending: 0` would put "대기 중인 항목이 없습니다"
   * under a button that had just done exactly what the operator asked for.
   */
  it("reports the x rows the passthrough wrote, even though no worksheet was needed", async () => {
    const written: string[] = [];
    const passthrough = [{ itemId: "x:1", type: "x", sourceKorean: "승인 카피" }];
    const prepare = { run: async () => ({ worksheet: "", pending: [], passthrough }) };
    const uc = new PrepareConversionRun(prepare as never, async (p) => { written.push(p); }, "/ws", () => "STAMP");

    const res = await uc.run({ itemId: "x:1", types: ["x"] });

    expect(res.passthrough).toBe(1);
    expect(res.pending).toBe(0);
    expect(written).toEqual([]);
  });

  it("passes the item and types through as a selector", async () => {
    let seen: unknown;
    const prepare = { run: async (sel: unknown) => { seen = sel; return { worksheet: "w", pending: [{ itemId: "x:1", type: "casual", sourceKorean: "s" }] }; } };
    const uc = new PrepareConversionRun(prepare as never, async () => {}, "/ws", () => "S");

    await uc.run({ itemId: "x:1", types: ["casual", "explainer"] });

    expect(seen).toEqual({ ids: ["x:1"], types: ["casual", "explainer"] });
  });

  /**
   * The brief's own `PrepareConversionRun` only writes the worksheet — but the design spec says
   * `[변환 준비]` "runs `convert:prepare`", and the CLI's `convert:prepare` also persists the pending
   * batch to `output/variants/pending.json`. That persistence is not cosmetic: the agent's next
   * step, `pnpm convert:save --id <id> --type <t> --file <ko.txt>`, reads that file to find each
   * item's `sourceKorean` (see `src/cli/convert-save.ts`). Skip it here and the operator gets a
   * worksheet the agent can fill, then a `convert:save` that throws "run convert:prepare first" for
   * every item this run just prepared, because the pending record was never written down.
   */
  it("persists the pending batch so convert:save can find each item's sourceKorean", async () => {
    const saved: unknown[] = [];
    const pending = [{ itemId: "x:1", type: "announcement", sourceKorean: "s" }];
    const prepare = { run: async () => ({ worksheet: "w", pending }) };
    const uc = new PrepareConversionRun(prepare as never, async () => {}, "/ws", () => "S", async (p) => { saved.push(p); return undefined; });

    await uc.run({ itemId: "x:1", types: ["announcement"] });

    expect(saved).toEqual([pending]);
  });

  it("does not persist a pending batch when nothing is pending", async () => {
    const saved: unknown[] = [];
    const prepare = { run: async () => ({ worksheet: "", pending: [] }) };
    const uc = new PrepareConversionRun(prepare as never, async () => {}, "/ws", () => "S", async (p) => { saved.push(p); return undefined; });

    await uc.run({ itemId: "x:1", types: ["announcement"] });

    expect(saved).toEqual([]);
  });

  /**
   * `savePending` uses `archiveFile` (a `rename`) under the hood: preparing item B while the agent
   * is still filling item A's worksheet moves A's pending batch out from under it, and the CLI's own
   * `console.log` for this never reaches a dashboard operator. `archived` is the only channel that
   * can carry the warning to the UI — dropping it here means the operator finds out only when
   * `convert:save` throws "run convert:prepare first" for every item in the batch that just vanished.
   */
  it("forwards the archived-previous-batch path when savePending reports one", async () => {
    const pending = [{ itemId: "x:1", type: "casual", sourceKorean: "s" }];
    const prepare = { run: async () => ({ worksheet: "w", pending }) };
    const uc = new PrepareConversionRun(
      prepare as never,
      async () => {},
      "/ws",
      () => "S",
      async () => "/archive/2026-07-29/pending-variants-x.json",
    );

    const res = await uc.run({ itemId: "x:1", types: ["casual"] });

    expect(res.archived).toBe("/archive/2026-07-29/pending-variants-x.json");
  });

  it("omits archived when savePending reports nothing to archive", async () => {
    const pending = [{ itemId: "x:1", type: "casual", sourceKorean: "s" }];
    const prepare = { run: async () => ({ worksheet: "w", pending }) };
    const uc = new PrepareConversionRun(prepare as never, async () => {}, "/ws", () => "S", async () => undefined);

    const res = await uc.run({ itemId: "x:1", types: ["casual"] });

    expect(res.archived).toBeUndefined();
  });
});
