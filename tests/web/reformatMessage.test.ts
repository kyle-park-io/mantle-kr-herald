import { describe, expect, it } from "vitest";
import { reformatMessage } from "../../web/src/reformatMessage";

const warning = { itemId: "x:1", type: "announcement" as const, channel: "telegram" as const, messages: ["over the X limit"] };

describe("reformatMessage", () => {
  /**
   * `FormatVariants.selectApprovedVariants` only picks up `status === "approved"` variants —
   * `convert:save` without `--approve` leaves one `"converted"`, invisible to a reformat. Without
   * this branch, `rendered === 0` and "regenerated cleanly" both produce no message, so the operator
   * cannot tell a silent no-op apart from a real (if uneventful) reformat.
   */
  it("names the likely cause when nothing was rendered", () => {
    const message = reformatMessage({ rendered: 0, warnings: [] }, "공지");
    expect(message).not.toBeNull();
    expect(message).toContain("승인");
    expect(message).toContain("convert:save --approve");
  });

  it("still surfaces format warnings when something was rendered", () => {
    const message = reformatMessage({ rendered: 1, warnings: [warning] }, "공지");
    expect(message).toContain("over the X limit");
  });

  it("is silent when the reformat rendered something and produced no warnings", () => {
    expect(reformatMessage({ rendered: 1, warnings: [] }, "공지")).toBeNull();
  });

  it("prefers the not-approved message over warnings when both are somehow present", () => {
    // Not reachable through FormatVariants today (warnings are per rendered destination), but the
    // precedence should still be deterministic: rendered === 0 is the more actionable fact.
    const message = reformatMessage({ rendered: 0, warnings: [warning] }, "공지");
    expect(message).toContain("승인");
  });
});
