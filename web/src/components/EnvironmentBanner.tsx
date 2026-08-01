import type { AppStatus } from "../types";

/**
 * Persistent, non-dismissible strips shown above the header. Neither has a close button and neither
 * is hidden by scrolling past it (the caller renders this `shrink-0`, same as the header) — the
 * whole point of both is to still be on screen the moment someone reaches for 승인 or 발송, not just
 * once on load.
 *
 * Absent fields — an older cached `/api/status` response, or a test fixture that predates one of
 * the two — render no banner rather than guessing: "unknown" is not "wrong", and a banner that fires
 * on a field it cannot actually read would just be noise. A real response always carries both
 * (`createDeps.ts`'s `loadStatus`).
 */
export function EnvironmentBanner({ status }: { status: AppStatus | null }) {
  if (!status) return null;
  return (
    <>
      {status.dbEnv === "development" && (
        <div className="shrink-0 bg-amber-ink px-5 py-2 text-center text-[13px] font-semibold text-white">
          ⚠ 개발 데이터베이스에 연결되어 있습니다 — 여기서 승인·발송한 내용은 실제 서비스에 반영되지 않습니다.
        </div>
      )}
      {status.sendsEnabled === false && (
        <div className="shrink-0 border-b border-amber-ink/20 bg-amber-soft px-5 py-2 text-center text-[13px] font-medium text-amber-ink">
          발송이 아직 열려 있지 않습니다 — 1차·2차 승인이 자리잡으면 팀이 직접 엽니다. [발송]을 눌러도 실제 채널에는
          올라가지 않습니다.
        </div>
      )}
    </>
  );
}
