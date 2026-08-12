import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { datePrefix, INTAKE_DISABLED_MESSAGE, INTAKE_OUTCOME_MESSAGE, type IntakePendingItem } from "../types";
import { btnPrimary } from "../buttonStyles";
import { KindBadge } from "./TranslationList";

/**
 * 링크 수집 — paste an x.com link, `POST /api/intake/x` lands the thread in the database.
 *
 * The waiting list below the form is not decoration. `herald-watch` only builds a translation row
 * for a collected item on its own two-hour tick (`translate:prepare`, `*:17`) — 1차 검수 lists
 * *translations*, so between the click here and that tick, the item exists nowhere a reviewer can
 * see it. Without this list the feature reads as "I pasted it and it vanished"; with it, the wait
 * reads as a schedule rather than a failure.
 *
 * The list keeps loading even when `intakeEnabled` is false: `api.intakePending()` reads the
 * database, not the credential, so a deployment with no `TWITTERAPI_IO_KEY` still shows the
 * operator the real queue instead of a blank tab that looks broken.
 */
export function IntakeView(props: { authEpoch: number; intakeEnabled: boolean }) {
  const { authEpoch, intakeEnabled } = props;
  const [pending, setPending] = useState<IntakePendingItem[]>([]);
  const [url, setUrl] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    // Cleared up front, mirroring `handleSubmit` below: a cold-start visit's first GET can 401
    // before login (`Root.tsx` hides `<App>` across `#login` rather than unmounting it), and without
    // this the stale error from that first failed read would sit on screen forever next to a list
    // that the post-login retry populated correctly.
    setError(null);
    return api.intakePending().then(setPending).catch((e) => setError(String((e as Error)?.message ?? e)));
  }, []);
  // `authEpoch` — see `RenderingsView`'s own doc comment on the same effect: `<App>` only ever hides
  // across a `#login` round trip rather than remounting, so without this a cold-start login landing
  // here first would 401 once and never retry.
  useEffect(() => {
    void refresh();
  }, [refresh, authEpoch]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !intakeEnabled || !url.trim()) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const reply = await api.intakeSubmit(url.trim());
      setOutcome(INTAKE_OUTCOME_MESSAGE[reply.outcome]);
      setPending(reply.pending);
      setUrl("");
    } catch (err) {
      // `api.intakeSubmit` throws `ApiError` for every non-ok response (the route's refusals are all
      // 400s with a Korean reason — see `apiHandlers.ts`), so its `.message` is what to show verbatim.
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://x.com/.../status/..."
            aria-label="x.com 링크"
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink outline-none placeholder:text-faint focus:border-mint focus:ring-[3px] focus:ring-mint/15"
          />
          <button type="submit" disabled={!intakeEnabled || !url.trim() || busy} className={`${btnPrimary} shrink-0 whitespace-nowrap`}>
            넣기
          </button>
        </form>

        {/* Visible text, not a hover — a reason you have to discover by hovering is a reason nobody
            reads, and a disabled button gives a keyboard user nothing else to read at all. */}
        {!intakeEnabled && (
          <p className="mt-2 text-[13px] font-medium text-amber-ink">{INTAKE_DISABLED_MESSAGE}</p>
        )}
        {outcome && <p className="mt-2 text-[13px] font-medium text-mint">{outcome}</p>}
        {error && (
          <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] leading-snug text-red-600">
            {error}
          </p>
        )}

        <p className="mt-6 text-[12px] font-medium text-faint">번역 틱은 두 시간마다 매시 17분에 돕니다</p>

        {pending.length === 0 ? (
          <p className="mt-2 text-[13px] text-faint">대기 중인 항목이 없습니다</p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
            {pending.map((item) => (
              <li key={item.itemId} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="flex items-center gap-2">
                  <code className="truncate font-mono text-[11px] text-faint">{item.itemId}</code>
                  <KindBadge kind={item.kind} />
                </div>
                <p className="line-clamp-2 text-[13px] leading-snug text-ink/90">
                  {/* Unlike `Translation.sourcePostedAt`, `createdAt` here is never absent — the row
                      would not exist without it — so no guard is needed before formatting it. */}
                  <span className="mr-1 font-mono text-faint">{datePrefix(item.createdAt)}</span>
                  {item.text}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
