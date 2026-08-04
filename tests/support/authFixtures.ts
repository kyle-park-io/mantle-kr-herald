/**
 * A structurally real `HERALD_AUTH_PASSWORD_HASH`: 16-byte salt, 32-byte key — the shape
 * `hashPassword` emits and the only shape `decodePasswordHash` accepts.
 *
 * Shared because several suites need to stand up a configured account, and the values they used
 * before (`scrypt$test$test`, `scrypt$65536$8$1$c2FsdA==$aGFzaA==`) were ones `verifyPassword` has
 * always rejected — so those suites were asserting against a configuration that could never have
 * authenticated anyone. `tryLoadAuthConfig` now refuses them at startup, which is what turned that
 * latent nonsense into a failing test.
 *
 * No password corresponds to this: it is for loaders and wiring, not for logging in.
 */
export const VALID_PASSWORD_HASH =
  "scrypt$65536$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
