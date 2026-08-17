# mantle-kr-herald

Social media content pipeline for the Mantle KR team — collect, translate, convert, format,
review, and publish, with a human review gate at every step.

## Quick start

```bash
pnpm install
cp .env.example .env

# Then open .env and fill in the values `doctor` treats as required. A copied skeleton has none
# of them, so every command below fails until they are set: DATABASE_URL + HERALD_DB_ENV (no
# database yet? `docs/ko/quickstart.md` §1.5 starts one in a container), and the dashboard's
# three — HERALD_AUTH_USERNAME, HERALD_AUTH_PASSWORD_HASH (both printed by `pnpm auth:hash`) and
# HERALD_SESSION_SECRET (`openssl rand -hex 32`).

pnpm db:import --yes    # applies the schema; a fresh clone has nothing to import, so that is all
pnpm config:init
pnpm doctor
pnpm status

# The review dashboard, at http://localhost:5757. `web/dist/` is git-ignored, so a fresh clone
# has no bundle for the server to hand out — without the build, `/` answers 500 (ENOENT on
# web/dist/index.html) while `/api/*` works fine, which reads like a broken install rather than
# a missing step.
pnpm build:web
pnpm serve
```

## Documentation map

Korean documentation starts at **[`docs/ko/README.md`](docs/ko/README.md)**, which routes you to
the right document by role.

| Document | Audience | Language | What's in it |
|---|---|---|---|
| [`docs/ko/capabilities.md`](docs/ko/capabilities.md) | Everyone | Korean | What this project does, the pipeline stages, what it deliberately does not do |
| [`docs/ko/review.md`](docs/ko/review.md) | Reviewers — **no terminal needed** | Korean | Reading, editing and approving translations and channel copy in the browser dashboard |
| [`docs/ko/quickstart.md`](docs/ko/quickstart.md) | External / new users | Korean | Five-minute local-mode start, no credentials required |
| [`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) | Mantle KR team operators | Korean | Weekly routine, cloud-mode setup, incident response |
| [`docs/ko/artifacts.md`](docs/ko/artifacts.md) | Anyone debugging a command | Korean | Every command's reads/writes, storage modes, sync ledger, retention policy |
| [`docs/ko/setup/steering.md`](docs/ko/setup/steering.md) | Anyone with an empty glossary | Korean | How to obtain the real steering config — it is not in git, and `pnpm config:init` writes empty skeletons that `doctor` used to report as fine |
| [`docs/ko/setup/vercel.md`](docs/ko/setup/vercel.md) | Whoever deploys | Korean | Putting the dashboard on Vercel over Postgres so the team reviews and approves from a URL — env vars, the origin bootstrap, and what stays local |
| [`docs/ko/setup/`](docs/ko/setup/) | Anyone setting up a credential | Korean | Step-by-step setup procedures for the Lark app, Google OAuth, and Drive folders — the single source of truth (SSOT); every other doc links here instead of re-explaining the steps |
| [`docs/README.md`](docs/README.md) | Contributors | English | Documentation rules — where a new doc belongs, SSOT policy |
| [`docs/architecture/`](docs/architecture/) | Contributors | English | Hexagonal architecture, external integrations |
| [`CHANGELOG.md`](CHANGELOG.md) | Anyone tracking releases | English | Release history |
