# Dashboard authentication on Vercel — options record

**Date:** 2026-07-29
**Status:** recorded, not decided. Kyle will revisit this in detail.
**Decided so far:** the login page ships as a single shared account — id + password checked
against a stored hash. Everything below is the wider question that decision defers, not replaces.

## Why this record exists

The dashboard is about to leave the operator's machine. Two properties that the current design
leans on stop holding the moment it does, and both are load-bearing.

### 1. The security model today is "no auth, bound to loopback"

`src/adapters/web/HttpServer.ts` says so in its own words. `refusalReason()` is the single
chokepoint, and it defends exactly one thing — a cross-site form POST from a page the operator
already has open. It does that well. It is not an authentication boundary and was never meant to
be one.

What sits behind that boundary is not a viewer. `SendChannels`, `PublishTranslations` and
`ApproveRendering` reach live rooms: the brand's X account through Typefully, Telegram rooms,
Lark. Those posts cannot be recalled. On the public internet, the login page is the only thing
between an anonymous request and an irreversible publish.

### 2. Serverless has no writable disk, and this app's record of truth is a disk

`src/paths.ts` fixes every artifact under `output/` — translations, variants, formatted copy, the
publish ledger, the delivery ledger, lineage. The dashboard writes to all of it. Vercel functions
get a read-only filesystem plus an ephemeral `/tmp` that does not survive the instance.

So "put the dashboard on Vercel" is really two projects, and the storage one is the larger:

- **Storage** — replace `Json*Store` and `File*Config` with something durable (Postgres, KV, or
  Drive as the record of truth via the existing `HERALD_STORAGE_MODE=cloud` path). The port
  interfaces already exist, which is what makes this tractable at all.
- **Auth** — this document.

Neither depends on the other's details, but auth without storage is a login page in front of an
app that forgets everything, and storage without auth is an open publish button.

## The options

### A. Google sign-in (OIDC) + signed httpOnly session cookie

Team members sign in with the Google account they already use. An allowlist of team emails
decides who gets in; the session is a signed, `httpOnly`, `Secure`, `SameSite=Lax` cookie.

- The project already carries `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` for Drive and Sheets, so the
  client exists. User sign-in is a different flow and scope, but not a new vendor relationship.
- **Per-user identity is the real argument.** The dashboard's whole culture is 1차/2차 검수 with a
  human in the loop and no auto-approval. Once the app knows the request is from a specific
  person, "approved by" and "sent by" become recordable facts. A shared credential cannot
  produce that, ever.
- No password to store. MFA and offboarding are inherited from Google.
- Cost: an OAuth callback route, a cookie-signing secret, and session handling.

### B. Vercel platform protection (Vercel Authentication)

Vercel gates the whole deployment behind a team login. Zero application code.

- Excellent as an **interim** guard — the right thing to switch on for a staging deploy while the
  storage migration is in flight.
- Two limits make it insufficient as the end state: every teammate needs a paid Vercel seat, and
  the application never learns who the user is, so an audit trail is impossible.

### C. Shared credential (id + password against a hash)

**This is what the login page is being built against.** Recorded here with its trade-offs so the
later conversation starts from an accurate picture, not so the decision gets relitigated.

- Fastest to build, no third-party dependency, no per-seat cost, and for a team that already
  shares the brand's X account it is not obviously the wrong grain.
- What it gives up: the app cannot tell teammates apart, so there is no audit trail of who
  approved or who sent. Rotating the password means telling everyone. There is no MFA.
- Two implementation details that matter more than the choice itself:
  - Verify with a **slow** password hash — argon2id or bcrypt, not SHA-256. A fast hash over a
    single human-chosen password is brute-forceable offline if the hash ever leaks.
  - Compare in **constant time**, and rate-limit failed attempts. One account means one target.

### JWTs specifically

The original question was whether to use JWTs. They earn their complexity when several
independent services must verify a token without shared state. Here there is one frontend and
one API, so that benefit does not arrive — but the costs do: a JWT stays valid until it expires,
so logout is not really logout, and a token kept in `localStorage` is readable by any XSS.

A signed session cookie is simpler, revocable, and unreadable from JavaScript. It is the better
default at this size regardless of which option above is chosen.

## Open questions for the follow-up conversation

1. Does an audit trail of who approved and who sent matter enough to require per-user identity?
2. Is the storage migration Postgres/KV, or does Drive become the record of truth via the
   existing `cloud` mode?
3. Should the public deployment be able to send at all, or should irreversible publishing stay on
   an operator's machine while the hosted dashboard stays read-only?
