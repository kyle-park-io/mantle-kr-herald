import type { FormatReply } from "./types";

/**
 * What `[포맷 다시]` should tell the operator after a reformat, or `null` when there is nothing to
 * say.
 *
 * `FormatVariants.selectApprovedVariants` only picks up variants with `status === "approved"` —
 * `convert:save` without `--approve` leaves a variant `"converted"`, which this route silently skips.
 * `rendered === 0` is exactly that case, and it must never read as a no-op: without this, the
 * operator reads the five-line "되돌릴 수 없습니다" confirm, clicks it, the server 200s with
 * `{rendered: 0, warnings: []}`, and — because `warnings.length > 0` was the only condition that
 * showed anything — nothing appears at all. The operator has no way to tell "regenerated, no
 * warnings" apart from "did not run", and walks away believing a fix they just made is live when
 * the card still holds the old text.
 */
export function reformatMessage(result: Pick<FormatReply, "rendered" | "warnings">, typeLabel: string): string | null {
  if (result.rendered === 0) {
    return `${typeLabel} 변환본이 아직 승인 상태가 아니라 아무것도 포맷되지 않았습니다 — pnpm convert:save --approve 로 승인한 뒤 다시 시도하세요.`;
  }
  if (result.warnings.length > 0) {
    return `⚠ 포맷 경고 ${result.warnings.length}건: ${result.warnings.flatMap((w) => w.messages).join("; ")}`;
  }
  return null;
}
