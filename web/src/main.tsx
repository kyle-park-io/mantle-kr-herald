import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api, installUnauthenticatedHandler } from "./api";
import { LoginPage } from "./components/LoginPage";
import "./styles.css";

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

  if (hash !== "#login") return <App onSignOut={signOut} />;
  return (
    <LoginPage
      onSubmit={async ({ username, password }) => {
        await api.login(username, password);
        window.location.hash = returnHash || "";
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
