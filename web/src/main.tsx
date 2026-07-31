import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./api";
import { LoginPage } from "./components/LoginPage";
import "./styles.css";

/**
 * `#login` renders the sign-in screen, which really does check the credential against the server.
 *
 * It is NOT yet a gate. A correct password proves the credential and nothing more: no session is
 * issued, and dropping the hash still lands in the dashboard. That is deliberate rather than
 * unfinished — a check that lives in the browser is not a check. What replaces it is decided, not
 * open: a signed, `httpOnly` session cookie, never a JWT — see
 * `docs/superpowers/specs/2026-07-31-hosted-writes-design.md`'s "Authentication" section, which
 * settled the question `docs/superpowers/specs/2026-07-29-dashboard-auth-options.md` originally
 * deferred. Landing task by task on this branch (`docs/superpowers/plans/2026-07-31-hosted-writes-
 * b-auth.md`); this file does not consult a session yet.
 *
 * The hash rather than a router: `App.tsx` already routes its two modes this way, and adding a
 * router for one pre-auth screen would be the larger change.
 */
function Root() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (hash !== "#login") return <App />;
  return (
    <LoginPage
      onSubmit={async ({ username, password }) => {
        await api.login(username, password);
        window.location.hash = "";
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
