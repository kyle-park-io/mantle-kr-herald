# Documentation

Rules for where documentation lives in this repository and how the pieces relate. For what the
project actually does, start at the root [`README.md`](../README.md#documentation-map), which
indexes every document.

## Folder map

| Folder | Audience | Language | Purpose |
|---|---|---|---|
| [`ko/`](ko/) | Everyone (external users and the Mantle KR team) | Korean | The living documentation: what the project does, how to run it locally, how the team operates it in cloud mode, and the exact read/write contract of every command. |
| [`en/`](en/) | Future external readers | English | Reserved for an English translation of `ko/`. Currently empty (`.gitkeep` only) — nothing here is out of date, there is simply nothing here yet. |
| [`architecture/`](architecture/) | Contributors | English | Design-level documentation: the hexagonal architecture pattern this codebase follows, and the external APIs/integrations it talks to. |
| [`guides/`](guides/) | Anyone setting up a credential | Korean | Step-by-step setup procedures — the single source of truth (SSOT) for how to create a Lark app, mint a Google OAuth token, provision Drive folders. Nothing outside this folder re-explains these steps. |
| [`superpowers/`](superpowers/) | Nobody (archive) | Mixed | A development-history archive of the plans and specs used while building this project. Not user documentation — do not link to it from `ko/`, `en/`, or the root `README.md`, and do not treat it as current: parts are stale by the time a feature ships. |

## Where does a new document go?

1. **Is it a setup procedure for a credential or external account?** → `guides/`. Nowhere else
   gets to explain *how* to create a Lark app or mint an OAuth token — everywhere else links here.
2. **Is it about what the project does, how to run it, or how the team operates it?** → `ko/`,
   written in Korean. This is almost every new document.
3. **Is it about the codebase's internal design (architecture pattern, external integrations)?**
   → `architecture/`, written in English.
4. **Is it a historical planning/spec document produced while building a feature?** →
   `superpowers/`, and it is understood to be an archive from the moment it lands — not
   something anyone maintains going forward.
5. **Is it a translation of an existing Korean doc?** → `en/`, mirroring the same filename as
   its `ko/` source.

If none of these fit, it probably belongs at the repo root (like `README.md` or
`CHANGELOG.md`) rather than under `docs/`.

## Rules

**SSOT (single source of truth).** Setup *procedures* — how to create a Lark app, mint a Google
OAuth token, provision a Drive folder — live only in `guides/`. Every other document links to
the relevant guide instead of re-explaining the steps. Without this rule, the prerequisites
sections of `ko/quickstart.md` and `ko/team-runbook.md` would each grow into a third and fourth
copy of the same procedure, and the three copies would drift the first time a console UI changes.

**Locale.** `ko/` is the source of truth; `en/` is a translation of it, not a parallel document.
Korean is updated first, on every change. An English page must never be the only place a fact
exists — if `en/` ever holds content, and a fact changes, the `ko/` counterpart is updated in the
same change, and the `en/` translation follows.

**Companion updates.** Some code changes have a mandatory documentation companion, in the same
change:
- Adding or renaming a CLI command requires updating `docs/ko/capabilities.md` (what it does),
  `docs/ko/artifacts.md` (what it reads/writes), and `.env.example` (any new environment
  variables) together.
- Changing where an artifact is stored requires updating `src/paths.ts` and
  `docs/ko/artifacts.md` together — `artifacts.md` is a verified reference, not a description
  written from memory; letting it drift from `src/paths.ts` defeats its purpose.
