export interface LarkMessage {
  messageId: string;
  chatId: string;
  msgType: string; // "text" | "post" (collected); preserved as-is
  createdAt: string; // ISO 8601 UTC (from create_time ms)
  senderId?: string;
  threadId?: string;
  parentId?: string;
  text: string; // plain text for translation
  rawContent: string; // original body.content JSON string
}

interface PostElement {
  text?: string;
}

/** Pure: extract plain text from a Lark message body.content (per msg_type). */
export function extractText(msgType: string, content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "";
  }

  if (msgType === "text") {
    const text = (parsed as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }

  if (msgType === "post") {
    const post = parsed as { title?: unknown; content?: unknown };
    const lines: string[] = [];
    if (typeof post.title === "string" && post.title.length > 0) lines.push(post.title);
    if (Array.isArray(post.content)) {
      for (const paragraph of post.content) {
        if (!Array.isArray(paragraph)) continue;
        const line = paragraph
          .map((el) => (typeof (el as PostElement).text === "string" ? (el as PostElement).text : ""))
          .join("");
        lines.push(line);
      }
    }
    return lines.join("\n");
  }

  return "";
}
