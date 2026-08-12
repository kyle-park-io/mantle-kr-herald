import { useEffect, useState } from "react";

/**
 * The current instant, re-read once a minute — the clock behind the header's countdown pies
 * (`tickSchedule.ts`), and the first `setInterval` in this frontend.
 *
 * Called ONCE, in `App`, and the resulting `Date` handed to both pies: two calls would be two
 * intervals drifting a few hundred milliseconds apart, and the two countdowns disagreeing about what
 * time it is. It re-renders `App` — the whole board — every 60 seconds, which is affordable and safe:
 * a re-render is not a remount, so every draft in the tree (`TranslationDetail`, `OutletCard`) keeps
 * its state, and nothing below re-fetches on a render. A second-hand would need 60× the renders to
 * show a digit nothing here displays.
 *
 * `visibilitychange` is not belt-and-braces. Browsers throttle timers hard in a background tab —
 * Chrome budgets them down to roughly once a minute and then far less for a tab that has been hidden
 * for minutes — so a reviewer who leaves this open, works elsewhere for an hour and comes back would
 * otherwise read an hour-old countdown for however long the throttled interval took to catch up.
 * Refreshing on the way back in costs one render and makes the first thing they look at true.
 *
 * Both the interval and the listener are cleaned up on unmount, and in this app that essentially
 * never happens: `Root.tsx` hides `<App>` across a `#login` round trip rather than unmounting it, and
 * only a deliberate 로그아웃 (a `sessionKey` bump) tears it down. So this interval lives for the
 * session — which is the intent, not an oversight.
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const read = () => setNow(new Date());
    const id = window.setInterval(read, intervalMs);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);

  return now;
}
