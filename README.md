# mantle-kr-herald

Social media content pipeline for the Mantle KR team — collect, translate, convert, format,
review, and publish, with a human review gate at every step.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm config:init
pnpm doctor
pnpm status
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
| [`docs/ko/setup/`](docs/ko/setup/) | Anyone setting up a credential | Korean | Step-by-step setup procedures for the Lark app, Google OAuth, and Drive folders — the single source of truth (SSOT); every other doc links here instead of re-explaining the steps |
| [`docs/README.md`](docs/README.md) | Contributors | English | Documentation rules — where a new doc belongs, SSOT policy |
| [`docs/architecture/`](docs/architecture/) | Contributors | English | Hexagonal architecture, external integrations |
| [`CHANGELOG.md`](CHANGELOG.md) | Anyone tracking releases | English | Release history |
