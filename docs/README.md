# Documentation

Rules for where documentation lives in this repository and how the pieces relate. For what the
project actually does, start at the root [`README.md`](../README.md#documentation-map), which
indexes every document.

## Folder map

Only **user-facing** documentation carries a language axis, so only it lives under a language
folder. Developer documentation is English by rule and the archive is read by nobody, so neither
belongs under `ko/` or `en/`.

| Folder | Audience | Language | Purpose |
|---|---|---|---|
| [`ko/`](ko/) | Everyone (external users and the Mantle KR team) | Korean | **All user-facing documentation**, including the credential setup procedures in [`ko/setup/`](ko/setup/). Start at [`ko/README.md`](ko/README.md), which routes a reader to the right document by role. |
| [`en/`](en/) | Future external readers | English | Reserved for a translation of `ko/`, mirroring its tree. Currently empty (`.gitkeep` only) — nothing here is out of date, there is simply nothing here yet. |
| [`architecture/`](architecture/) | Contributors | English | Design-level documentation: the hexagonal architecture pattern this codebase follows, and the external APIs/integrations it talks to. Not translated — developer documentation stays English. |
| [`superpowers/`](superpowers/) | Nobody (archive) | Mixed | A development-history archive of the plans and specs used while building this project. Not user documentation — do not link to it from `ko/`, `en/`, or the root `README.md`, and do not treat it as current: parts are stale by the time a feature ships. |

## Where does a new document go?

1. **Is it a setup procedure for a credential or external account?** → [`ko/setup/`](ko/setup/).
   Nowhere else gets to explain *how* to create a Lark app or mint an OAuth token — everywhere
   else links here.
2. **Is it about what the project does, how to run it, how to review its output, or how the team
   operates it?** → `ko/`, written in Korean. This is almost every new document. Add it to the
   role table in [`ko/README.md`](ko/README.md) in the same change, or nobody will find it.
3. **Is it about the codebase's internal design (architecture pattern, external integrations)?**
   → `architecture/`, written in English.
4. **Is it a historical planning/spec document produced while building a feature?** →
   `superpowers/`, and it is understood to be an archive from the moment it lands — not
   something anyone maintains going forward.
5. **Is it a translation of an existing Korean doc?** → `en/`, mirroring the same path as
   its `ko/` source (`ko/setup/lark.md` → `en/setup/lark.md`).

If none of these fit, it probably belongs at the repo root (like `README.md` or
`CHANGELOG.md`) rather than under `docs/`.

## Rules

**SSOT (single source of truth).** Setup *procedures* — how to create a Lark app, mint a Google
OAuth token, provision a Drive folder — live only in `ko/setup/`. Every other document links to
the relevant guide instead of re-explaining the steps. Without this rule, the prerequisites
sections of `ko/quickstart.md` and `ko/team-runbook.md` would each grow into a third and fourth
copy of the same procedure, and the three copies would drift the first time a console UI changes.

**One axis per level.** `docs/` splits by language *or* by audience, never both at the same level.
User docs carry a language, so they nest under `ko/`/`en/`; `architecture/` (English by rule) and
`superpowers/` (an archive) do not. This is why `setup/` sits inside `ko/` rather than beside it —
it is Korean user documentation, and putting it at the top level would mix the two axes again.

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
