# keys/ — local secret keys (git-ignored)

Put local credential files here. **The actual keys are git-ignored and must never be committed.**
`.gitignore` ignores everything in this folder except this README (`keys/*` + `!keys/README.md`).

## Google service account key (subsystem D)

Place the downloaded service-account JSON here, e.g. `keys/mantle-sa.json`, and point `.env` at it:

```bash
GOOGLE_SA_KEY_FILE=keys/mantle-sa.json
```

See `docs/guides/google-drive-setup-guide.md` for how to create the service account and key.

> Security: never commit real key files. `chmod 600 keys/*.json` recommended. Rotate periodically.
> Each teammate keeps their own key locally (automation runs on each person's machine).
