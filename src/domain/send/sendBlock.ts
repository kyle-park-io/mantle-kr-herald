/**
 * Why a room may not send yet — or `null` when it may.
 *
 * ONE predicate, deliberately shared by the actor (`SendChannels`) and the reporter (`buildBoard`),
 * the same way `isStale` backs both `drive:publish` and `pnpm status`. A board that paints [발송]
 * while the CLI refuses (or worse, the reverse) is the failure this shape exists to make impossible.
 *
 * Nothing here is written down. The block is computed from two approval stamps every time it is
 * asked for, so it cannot drift from the truth, and it clears itself the moment the reviewer
 * re-approves — no invalidation pass, no stored flag, no repair path.
 */
export type SendBlock =
  /** No translation behind this copy at all — there is nothing to check it against. */
  | "source-missing"
  /** 1차 approval is absent or was withdrawn. */
  | "source-unapproved"
  /** This room's own copy has not passed 2차 yet. */
  | "unapproved"
  /** The source was approved again *after* this copy was — the copy predates the current text. */
  | "source-changed";

/** A room's resolved copy: the group rendering, or its override when the room forked. */
export interface ReviewedCopy {
  status: "rendered" | "approved";
  approvedAt?: string;
}

/** The 1차 translation this copy descends from. */
export interface SourceApproval {
  status: string;
  approvedAt?: string;
}

export function sendBlock(copy: ReviewedCopy, source: SourceApproval | undefined): SendBlock | null {
  if (!source) return "source-missing";
  // Upstream first: while the source is unapproved, approving the copy would not release it, so
  // naming the copy would send the reviewer to a screen that cannot fix anything.
  if (source.status !== "approved") return "source-unapproved";
  if (copy.status !== "approved") return "unapproved";
  // ISO-8601 strings compare lexicographically in chronological order. `>=`, not `>`: approving a
  // translation and its renderings within the same millisecond is in order, not stale.
  if (source.approvedAt !== undefined && !(copy.approvedAt !== undefined && copy.approvedAt >= source.approvedAt)) {
    return "source-changed";
  }
  return null;
}

/** What the dashboard and the CLI both tell the operator. Korean, because both audiences read it. */
export const SEND_BLOCK_REASON: Record<SendBlock, string> = {
  "source-missing": "원문 번역을 찾을 수 없습니다",
  "source-unapproved": "원문이 1차 승인 상태가 아닙니다",
  unapproved: "아직 승인되지 않았습니다",
  "source-changed": "원문이 이 문구를 승인한 뒤에 다시 승인됐습니다 — 다시 검수하거나 변환을 새로 하세요",
};
