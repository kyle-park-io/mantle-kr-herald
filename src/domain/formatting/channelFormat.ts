import type { Channel, FormatOptions, FormatResult } from "./models";

export { ALL_CHANNELS, DEFAULT_CHANNELS_BY_TYPE } from "./models";
export type { Channel, FormatOptions, FormatResult, ChannelRendering } from "./models";

const X_LIMIT = 280;
const BOLD = /\*\*([\s\S]+?)\*\*/g;
const MD_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;

const collapseBlankLines = (t: string): string => t.replace(/\n{3,}/g, "\n\n");
const stripBold = (t: string): string => t.replace(BOLD, "$1");
const boldToTelegram = (t: string): string => t.replace(BOLD, "*$1*");
const linksToPlain = (t: string): string => t.replace(MD_LINK, "$1 ($2)");

/** Map ASCII letters/digits inside **bold** to Unicode Sans-Serif Bold (reads naturally on X). */
function boldToUnicode(t: string): string {
  return t.replace(BOLD, (_m, inner: string) =>
    [...inner]
      .map((ch) => {
        const c = ch.codePointAt(0)!;
        if (c >= 0x41 && c <= 0x5a) return String.fromCodePoint(0x1d5d4 + (c - 0x41)); // A-Z
        if (c >= 0x61 && c <= 0x7a) return String.fromCodePoint(0x1d5ee + (c - 0x61)); // a-z
        if (c >= 0x30 && c <= 0x39) return String.fromCodePoint(0x1d7ec + (c - 0x30)); // 0-9
        return ch;
      })
      .join(""),
  );
}

export function formatForChannel(text: string, channel: Channel, opts: FormatOptions = {}): FormatResult {
  const warnings: string[] = [];
  switch (channel) {
    case "x": {
      const bolded = opts.xBold === "unicode" ? boldToUnicode(text) : stripBold(text);
      const out = collapseBlankLines(linksToPlain(bolded)).trim();
      if ([...out].length > X_LIMIT) warnings.push(`exceeds ${X_LIMIT} chars (${[...out].length}); consider splitting into a thread`);
      return { text: out, warnings };
    }
    case "telegram":
      // v1: legacy Telegram Markdown (`*bold*`), links preserved. Full MarkdownV2
      // escaping of reserved characters is intentionally deferred to the `--refine`
      // pass / §8 upload (which must choose an appropriate parse_mode or a plain-text
      // fallback).
      return { text: collapseBlankLines(boldToTelegram(text)).trim(), warnings };
    case "kakao":
      return { text: collapseBlankLines(linksToPlain(stripBold(text))).trim(), warnings };
    case "pr_mail": {
      const plain = linksToPlain(stripBold(text)).trim();
      const lines = plain.split("\n");
      const subject = (lines.shift() ?? "").trim();
      const body = collapseBlankLines(lines.join("\n")).trim();
      return { text: `제목: ${subject}\n\n${body}`, warnings };
    }
  }
}
