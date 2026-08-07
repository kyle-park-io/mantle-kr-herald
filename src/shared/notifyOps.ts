const API = "https://api.telegram.org";

/**
 * A one-off Telegram alert to the ops room, for events worth a human's attention that are not a
 * unit *failure* — `x:reconcile` retiring several translations in one run is the first caller (see
 * `src/cli/x-reconcile.ts`), which is exactly the case `deploy/herald-notify-failure.sh`'s
 * `OnFailure=` hook never sees, because the run that did the retiring succeeded.
 *
 * Deliberately mirrors that script's env contract rather than inventing its own: both
 * `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID_OPS` must be set, or this is a silent no-op. An
 * operator who has already configured one alert path (the failure hook) expects the other to be
 * gated by the same switch, not a second variable they have to discover and set separately.
 *
 * Never throws. An alert must never fail the run that raised it — the same posture
 * `herald-notify-failure.sh` keeps via its own unconditional `exit 0`, just enforced here with a
 * try/catch instead of a shell trap, since this runs inside the process it is alerting about
 * rather than as a separate `OnFailure=` unit.
 *
 * `fetchFn` is a second, optional parameter purely for testability — every real caller passes just
 * `text` and gets the module-level `fetch`, matching this file's "runtime dependencies stay
 * zod-only; notifyOps uses global fetch" constraint. Same shape `TelegramBotSender` already uses
 * for its own injectable `fetchFn`.
 */
export async function notifyOps(text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID_OPS;
  // Unset means: no ops room configured (yet, or ever, on this install) — the same fail-safe
  // posture herald-notify-failure.sh takes when it finds either variable empty. This must never
  // read as "notifyOps is broken"; there is simply nowhere configured to send to.
  //
  // Announced rather than returned silently, because an unconfigured install and a successful send
  // used to produce the SAME journal — nothing — and they call for opposite responses.
  if (!token || !chatId) {
    const missing = [!token && "TELEGRAM_BOT_TOKEN", !chatId && "TELEGRAM_CHAT_ID_OPS"].filter(Boolean).join(" and ");
    console.log(`[notifyOps] ${missing} not set — no ops chat configured, alert not sent`);
    return;
  }

  try {
    const res = await fetchFn(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      // Mirrors curl -fsS's fail-on-HTTP-error behaviour in herald-notify-failure.sh: a rejection
      // by Telegram (bad token, bad chat id, ...) is a failure to swallow, not a reason to throw.
      throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
    }
    // The whole point of this line. A bot cannot read back its own sent messages (`getUpdates`
    // returns incoming updates only, and privacy mode hides the group besides), so delivery cannot
    // be confirmed after the fact through the API — the journal is the only record, and until this
    // existed it held nothing on the success path. "Did the alert go out?" was then a three-step
    // deduction: both env vars set, the caller's threshold met, and no failure line present,
    // therefore it sent. That is not a question an operator should have to reconstruct, and the
    // only other observer available is the human whose phone it was sent to.
    console.log(`[notifyOps] sent to ops chat ${chatId}`);
  } catch (err) {
    // Swallowed on purpose — see this function's own doc comment. Logged, not re-thrown: the
    // caller (x-reconcile.ts) already printed its own summary; a broken alert path should show up
    // somewhere an operator can find it, but must never turn a successful retire run into a
    // non-zero exit.
    console.error(`[notifyOps] failed to notify: ${(err as Error).message}`);
  }
}
