/** Sum all reaction counts in a post's reaction list. */
export function sumReactions(reactions: { emoji: string; count: number }[]): number {
  return reactions.reduce((sum, reaction) => sum + reaction.count, 0);
}

/**
 * Format reactions as a human-auditable string (e.g. "👍2 ❤1").
 * Preserves the order the parser produced; no sorting.
 */
export function formatReactions(reactions: { emoji: string; count: number }[]): string {
  return reactions.map((reaction) => `${reaction.emoji}${reaction.count}`).join(" ");
}
