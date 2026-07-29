import { describe, it, expect } from "vitest";
import { createSerializer } from "../../../src/shared/store/serialWrites";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("createSerializer", () => {
  it("runs jobs one at a time, in order", async () => {
    const serial = createSerializer();
    const order: string[] = [];
    const a = deferred();
    const first = serial(async () => { order.push("a:start"); await a.promise; order.push("a:end"); });
    const second = serial(async () => { order.push("b"); });
    // `b` must not have started while `a` is still in flight.
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    a.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  // One failed write must not wedge every write after it on the same instance.
  it("runs the next job even after its predecessor rejects", async () => {
    const serial = createSerializer();
    const ran: string[] = [];
    const failing = serial(async () => { ran.push("a"); throw new Error("boom"); });
    await expect(failing).rejects.toThrow("boom");
    await serial(async () => { ran.push("b"); });
    expect(ran).toEqual(["a", "b"]);
  });

  it("still rejects to the caller that owns the failing job", async () => {
    const serial = createSerializer();
    await expect(serial(async () => { throw new Error("mine"); })).rejects.toThrow("mine");
    await expect(serial(async () => "ok")).resolves.toBe("ok");
  });

  it("gives each serializer its own chain", async () => {
    const one = createSerializer();
    const two = createSerializer();
    const gate = deferred();
    const blocked = one(async () => { await gate.promise; });
    // A job on a different serializer must not wait behind it.
    await expect(two(async () => "free")).resolves.toBe("free");
    gate.resolve();
    await blocked;
  });
});
