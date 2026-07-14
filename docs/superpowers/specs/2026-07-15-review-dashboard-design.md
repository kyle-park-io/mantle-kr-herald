# Review Dashboard (Subsystem E) — Design

**Status:** Approved design (2026-07-15)
**Depends on:** C (translation store, `SaveTranslation`), D (`PublishTranslations`, Google uploader)

## Goal

A local web dashboard for the Mantle KR team to **review, edit, approve, and publish** the agent-produced Korean translations — the human-in-the-loop step between translation (C) and Drive upload (D).

## Deployment & usage

- **Local tool.** Each reviewer runs `pnpm serve` and opens `http://localhost:<port>`.
- No hosting, no authentication (single machine, local network only).
- Reads/writes the **same local stores the CLIs use** (`output/translations/…`), so the dashboard and the CLIs are interchangeable — approving in the UI is identical to `translate:save --approve`.

## Scope

**In (v1):**
- List translations by status (translated / approved).
- View source + Korean side by side, with `---` thread separators rendered.
- Edit the Korean text and save.
- Approve (translated → approved), which also promotes to the few-shot store (existing `SaveTranslation` behavior).
- Publish: trigger the Drive upload for unpublished translations.

**Out (v1):**
- Generating translations — done by the local Claude agent, not the UI.
- Authentication, hosting, multi-user.
- Lark Drive (blocked on Lark app approval) — publish defaults to Google; the target selector may list Lark but it is expected to fail until provisioned.
- Showing untranslated items awaiting translation (possible later addition).

## Architecture

Hexagonal, **backend unchanged**. The web layer is a new *delivery mechanism* (like the CLIs): a thin adapter over existing app use-cases, with no new domain logic.

- **Backend:** a `node:http` server that serves the built React bundle and a JSON API. Reuses `TranslationStore`, `SaveTranslation`, `PublishTranslations`, and the Google auth/uploader wiring.
- **Frontend:** React + Vite + TypeScript, isolated in `web/`, built to a static bundle.
- **Dependency isolation:** the Node runtime stays minimal (`zod` only); React/Vite are **build-time** deps that produce a static bundle served by the Node server.

### File layout

```
web/                          # frontend (Vite + React + TS), isolated, its own build
  index.html
  vite.config.ts
  src/
    main.tsx
    App.tsx
    api.ts                    # typed fetch wrappers for /api/*
    components/
      TranslationList.tsx     # left column: id + status badge, status filter
      TranslationDetail.tsx   # right: source (--- rendered) + editable Korean
      PublishBar.tsx          # top: target selector + publish button + result
src/
  adapters/web/
    HttpServer.ts             # node:http: static serving (web/dist) + JSON routing
    apiHandlers.ts            # request -> use-case -> response (thin; unit-tested)
  cli/serve.ts                # composition root: wire stores/use-cases/uploaders, start server, print URL
  # domain / ports / adapters / app — reused unchanged
```

## UI (master–detail)

```
┌─────────────────────────────────────────────────────────────┐
│ Mantle KR — Review              [target: google ▾] [발행 ⬆] │
├──────────────┬──────────────────────────────────────────────┤
│ 필터: 전체 ▾ │  x:2077000748…                 [translated]   │
│              │  ── 원문 (source) ─────────────────────────   │
│ ●2077000748… │  Everyone's got a champion...                 │
│  translated  │  ---                                          │
│ ○2076670159… │  One knockout call...                        │
│  approved    │  ── 한글 (Korean) ─────────────── [편집중]    │
│ ○2076292239… │  ┌────────────────────────────────────────┐  │
│  translated  │  │ 누구나 마음속에 우승 후보가...          │  │
│              │  │ ---                                      │  │
│              │  │ 녹아웃 경기 하나를...                    │  │
│              │  └────────────────────────────────────────┘  │
│              │  [저장]        [승인 ✓]                       │
└──────────────┴──────────────────────────────────────────────┘
```

- **Left:** list of translations (itemId + status badge); filter by status (all / translated / approved).
- **Right (detail):** source rendered read-only (with `---` between tweets), Korean in an editable `<textarea>`; `[저장]` saves the edit, `[승인]` approves.
- **Top bar:** target selector (Google default), `[발행]` publish, and a result/status indicator.
- **States:** loading, empty list, save/approve/publish success + error banners, and an unsaved-edit guard when switching items.

## API (thin layer over existing use-cases)

| Method | Path | Body | Use-case | Response |
| --- | --- | --- | --- | --- |
| GET | `/api/translations` | — | `TranslationStore.loadAll` | `Translation[]` |
| PUT | `/api/translations/:id` | `{ koreanText }` | `SaveTranslation` (approve=false) | updated `Translation` |
| POST | `/api/translations/:id/approve` | — | `SaveTranslation` (approve=true) | updated `Translation` |
| POST | `/api/publish` | `{ target }` | build uploaders for `target`, then `PublishTranslations.run` | `{ uploaded, failed, byDrive }` |

- `:id` is the url-encoded itemId (e.g. `x%3A2077…`).
- PUT / approve reload the existing `Translation` from the store to recover `source` / `sourceText`, apply the new `koreanText`, and re-save via `SaveTranslation`.
- Errors return JSON `{ error }`: 400 (bad/missing body), 404 (unknown id or route), 500 (use-case threw).

## Data flow

`serve.ts` wires the same adapters the CLIs use — `JsonTranslationStore("output/translations")` and `JsonPublishStore("output/publish")`. The API handlers call the use-cases; writes go through the existing atomic stores, so the UI and CLI never disagree. Publish mirrors `publish.ts`: the handler builds the uploaders for the requested `target` (Google via `loadGoogleAuth()` + `loadGoogleDriveConfig()`, Lark via its config) and runs `PublishTranslations`. Google auth/config errors surface as a `500 { error }` the UI shows.

## Commands / scripts

- `pnpm dev:web` — Vite dev server (HMR); proxies `/api` to the Node server during UI development.
- `pnpm build:web` — Vite build → `web/dist`.
- `pnpm serve` — start the `node:http` server serving `web/dist` + `/api` (run `build:web` first, or the server warns if `web/dist` is missing).

## Dependencies

Build-time only (Node runtime stays `zod`-only): `react`, `react-dom`, `vite`, `@vitejs/plugin-react` (`typescript` already present). Optional frontend tests: `vitest` (already present) + `@testing-library/react`.

## Error handling

- **API:** JSON errors + status codes; the server catches use-case throws and returns `500 { error }`.
- **Publish:** existing per-uploader isolation counts failures; the failed count surfaces in the UI.
- **Frontend:** error banners on failed calls; an unsaved-edit confirmation before navigating away from a dirty editor.

## Testing

- **Backend (primary):** unit-test `apiHandlers` with fake stores/use-cases (vitest) — route dispatch, status codes, body validation, and correct use-case wiring. Existing use-case tests already cover the domain behavior.
- **Frontend (light, proportionate to a local tool):** a couple of component/logic tests for the edit→save and approve flows, or a smoke test. No exhaustive UI coverage.

## Global constraints (from the project)

- Backend: TypeScript ESM, `moduleResolution: bundler` (no `.js` import extensions), native `fetch`, `node:*` built-ins, `zod` the only runtime dependency.
- Frontend: TypeScript, bundled by Vite (build step allowed here, isolated in `web/`).
- Code and comments in English; UI copy in Korean.
- Reuse existing `domain` / `app` — the web layer adds no domain logic.
