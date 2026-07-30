/**
 * Detect whether a post mentions Mantle (Korean name, English name, or ticker).
 * Uses token boundaries for the ticker to avoid false matches inside longer symbols.
 */
export function isMantleCandidate(text: string): boolean {
  if (!text) return false;

  // Match the Korean name "맨틀"
  if (text.includes("맨틀")) return true;

  // Match the English name "mantle" (case-insensitive)
  if (text.toLowerCase().includes("mantle")) return true;

  // Match the ticker "MNT" only at token boundaries (not inside MNTUSDT, MNTL, etc.)
  // Negative lookbehind and lookahead ensure MNT is not surrounded by alphanumerics
  if (/(?<![a-zA-Z0-9])MNT(?![a-zA-Z0-9])/i.test(text)) return true;

  return false;
}
