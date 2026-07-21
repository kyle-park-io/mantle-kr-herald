import { flattenPostBoundaries, linksToPlain, stripBold } from "../canonical";
import type { EmitResult } from "./types";

/**
 * RFC 5322 §2.1.1 makes 998 a MUST per line, and RFC 5321 §4.5.3.1.6 enforces it in **octets**.
 * UTF-8 Hangul is 3 octets per syllable, so this is reached at ~332 Korean characters — a very
 * different number from the 78-character SHOULD.
 */
export const MAIL_MAX_LINE_OCTETS = 998;

const encoder = new TextEncoder();
const octets = (line: string): number => encoder.encode(line).length;

/**
 * Subject on the first line, body after. Deliberately not hard-wrapped at 78 columns: that SHOULD
 * applies to mail actually put on the wire, and pre-wrapped text pasted into Gmail or Outlook is
 * re-wrapped by the client and reads as ragged. Subject encoding (RFC 2047) belongs to whatever
 * eventually sends the mail, not to this emitter.
 *
 * `length` and `limit` here describe the longest line in octets, not the whole message.
 */
export function emitPrMail(canonical: string): EmitResult {
  const plain = linksToPlain(stripBold(flattenPostBoundaries(canonical)));
  const lines = plain.split("\n");
  const subject = (lines.shift() ?? "").trim();
  const body = lines.join("\n").trim();
  const text = `제목: ${subject}\n\n${body}`;

  const measured = text.split("\n").map((line, i) => ({ line: i + 1, n: octets(line) }));
  const warnings = measured
    .filter(({ n }) => n > MAIL_MAX_LINE_OCTETS)
    .map(({ line, n }) => `${line}번째 줄이 ${n}옥텟 — RFC 5322 상한 ${MAIL_MAX_LINE_OCTETS}옥텟 초과`);
  const worst = Math.max(0, ...measured.map(({ n }) => n));

  return {
    segments: [{ text, length: worst, limit: MAIL_MAX_LINE_OCTETS, overLimit: warnings.length > 0 }],
    warnings,
  };
}
