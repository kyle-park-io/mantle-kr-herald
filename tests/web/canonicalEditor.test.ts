import { describe, expect, it } from "vitest";
import { toEditor, fromEditor } from "../../web/src/canonicalEditor";
import { toCanonical } from "../../src/domain/formatting/canonical";

describe("canonical editor view", () => {
  it("shows a post boundary as a --- rule", () => {
    expect(toEditor("첫 트윗.\n\n\n둘째 트윗.")).toBe("첫 트윗.\n\n---\n\n둘째 트윗.");
  });

  it("leaves a paragraph break alone — one blank line is not a boundary", () => {
    expect(toEditor("한 줄.\n\n다음 줄.")).toBe("한 줄.\n\n다음 줄.");
  });

  it("shows every boundary in a longer thread", () => {
    expect(toEditor("1\n\n\n2\n\n\n3")).toBe("1\n\n---\n\n2\n\n---\n\n3");
  });

  /**
   * The round trip is the whole safety argument: what the reviewer sees must mean exactly what is
   * stored, or an edit would silently move a boundary.
   */
  it("round-trips back to the stored form", () => {
    for (const canonical of ["첫.\n\n\n둘.", "1\n\n\n2\n\n\n3", "문단.\n\n다음 문단.", "경계 없음"]) {
      expect(fromEditor(toEditor(canonical)), canonical).toBe(canonical);
    }
  });

  /**
   * `fromEditor` only decides whether the box is dirty — the server re-canonicalises on save. It
   * must therefore agree with `toCanonical` about what a typed `---` means, or a reviewer who adds
   * one sees the card go clean while the stored text is about to change.
   */
  it("agrees with the server's toCanonical on a typed separator", () => {
    const typed = "첫 트윗.\n\n---\n\n둘째 트윗.";
    expect(fromEditor(typed)).toBe(toCanonical(typed));
  });

  it("treats a separator the reviewer typed with stray spaces as a boundary too", () => {
    expect(fromEditor("첫.\n\n  ---  \n\n둘.")).toBe("첫.\n\n\n둘.");
  });
});
