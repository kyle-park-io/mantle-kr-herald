import { describe, it, expect } from "vitest";
import { extractText } from "../../src/domain/larkMessage";

describe("extractText", () => {
  it("returns the text field for a text message", () => {
    expect(extractText("text", JSON.stringify({ text: "hello world" }))).toBe("hello world");
  });

  it("flattens a post message (title + paragraphs) to plain text", () => {
    const content = JSON.stringify({
      title: "Update",
      content: [
        [{ tag: "text", text: "Line one " }, { tag: "a", text: "link", href: "https://x" }],
        [{ tag: "text", text: "Line two" }],
      ],
    });
    expect(extractText("post", content)).toBe("Update\nLine one link\nLine two");
  });

  it("returns empty string for unsupported types", () => {
    expect(extractText("image", JSON.stringify({ image_key: "img_x" }))).toBe("");
  });

  it("returns empty string when content is not valid JSON", () => {
    expect(extractText("text", "{ not json")).toBe("");
  });

  it("returns empty string when content parses to null (text)", () => {
    expect(extractText("text", "null")).toBe("");
  });

  it("returns empty string when content parses to null (post)", () => {
    expect(extractText("post", "null")).toBe("");
  });

  it("skips null elements inside a post paragraph", () => {
    expect(extractText("post", '{"content":[[null,{"tag":"text","text":"ok"}]]}')).toBe("ok");
  });
});
