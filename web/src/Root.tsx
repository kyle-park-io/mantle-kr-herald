import { useEffect, useState } from "react";
import { App } from "./App";
import { api, installUnauthenticatedHandler } from "./api";
import { LoginPage } from "./components/LoginPage";

/**
 * Where a `#login` redirect came from, so a successful sign-in returns there instead of always the
 * board root. Captured once, the moment the redirect happens (below) — not on every hash change, or
 * browsing while already on `#login` would keep overwriting it with `"#login"` itself.
 */
let returnHash = "";

/**
 * Sends the browser to `#login`, remembering where it was. Used both as the API layer's 401 handler
 * (a lost session) and by the sign-out control in `App.tsx` (a deliberate one) — the same landing
 * spot either way, so a reviewer picking back up after either one returns to the screen they left.
 */
function goToLogin() {
  if (window.location.hash !== "#login") returnHash = window.location.hash;
  window.location.hash = "#login";
}

installUnauthenticatedHandler(goToLogin);

async function signOut() {
  try {
    await api.logout();
  } finally {
    // Ends the visit locally even if the network call failed — a signed-out screen the operator
    // asked for should not depend on the server being reachable to show it.
    goToLogin();
  }
}

/**
 * `#login` renders the sign-in screen, which checks the credential against the server and — since
 * Task 4 — receives a signed, `httpOnly` session cookie on success. Every other request now passes
 * through the gate in `HttpServer.ts`; `json()` (`api.ts`) is what notices a 401 and calls
 * `goToLogin` above, so no call site has to remember to check for one itself.
 *
 * `<App>` stays mounted the whole time, `#login` included — merely hidden (`display:none`) rather
 * than swapped out for `<LoginPage>`. It used to be the latter, and that was the bug: at a 12-hour
 * session lifetime an expiry mid-edit was theoretical, but Kyle shortened `SESSION_TTL_MS` to 2
 * hours (see that constant's own comment), which makes "a reviewer is mid-edit on a 2차 rendering
 * when the session lapses" a real event, not an edge case. Unmounting `<App>` on every 401 —
 * including the 401 a `저장` click itself can now trigger — destroyed every bit of React state under
 * it, the very textarea holding the reviewer's unsaved text included. Hiding it instead keeps that
 * state alive; re-authenticating just reveals the same screen, unsaved edit and all, so the reviewer
 * only has to click `저장` again, not retype anything. (`App.tsx`'s own hash-driven mode router has a
 * matching fix — see its comment — since without it the pseudo-route this hash change introduces
 * would flip `mode` away from "renderings" and back, unmounting `RenderingsView` itself in between.)
 *
 * The hash rather than a router: `App.tsx` already routes its two modes this way, and adding a
 * router for one pre-auth screen would be the larger change.
 *
 * `authEpoch` exists because "never unmount `<App>`" has a corollary this file's own history missed
 * at first: `<App>` (and `RenderingsView` inside it) load their data in a mount-only effect
 * (`useEffect(..., [])`). Unmounting used to be *why* a fresh login always saw fresh data — a
 * remount is a brand-new component instance, and its mount effect runs again. Hiding instead of
 * unmounting keeps the SAME instance, so that effect never re-fires on its own — harmless for the
 * bug this file exists to fix (a reviewer who already had data loaded, mid-edit, just needs their
 * draft back), but wrong for the far more common path through this same overlay: the very first
 * login of the day, from a cold dashboard with no session yet. `<App>` still mounts immediately (its
 * data effect does not wait for auth), so that first fetch 401s, `items`/`status` stay empty, and
 * without `authEpoch` a successful login would reveal a dashboard permanently reporting "해당하는
 * 항목이 없습니다" — not because there is nothing to review, but because the one fetch that would
 * have found something already happened and failed, before there was anything to authenticate with.
 * Incrementing `authEpoch` on every successful login and feeding it into `<App>`'s (and, through it,
 * `RenderingsView`'s) data-loading effect's own dependency array makes login — first-time or a
 * mid-edit re-auth alike — always retry the fetch. Re-running it after a mid-edit re-auth is safe
 * for an in-progress draft for the same reason `TranslationDetail`/`OutletCard`'s own local text
 * state already relies on: each resets its draft only when the underlying field's *value* changes,
 * and a refetch with no intervening save returns that same value.
 */
export function Root() {
  const [hash, setHash] = useState(() => window.location.hash);
  const [authEpoch, setAuthEpoch] = useState(0);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const showingLogin = hash === "#login";
  return (
    <>
      <div className={showingLogin ? "hidden" : undefined}>
        <App onSignOut={signOut} authEpoch={authEpoch} />
      </div>
      {showingLogin && (
        <LoginPage
          onSubmit={async ({ username, password }) => {
            await api.login(username, password);
            setAuthEpoch((e) => e + 1);
            window.location.hash = returnHash || "";
          }}
        />
      )}
    </>
  );
}
