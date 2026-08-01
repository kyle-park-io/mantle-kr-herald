// tests/support/fakeApiDeps.ts
import type { ApiDeps } from "../../src/adapters/web/apiHandlers";
import { SESSION_TTL_MS } from "../../src/domain/auth/session";
import type { ClientIpConfig } from "../../src/config";

/** Off — the safe default `loadClientIpConfig()` itself returns when `HERALD_TRUST_PROXY` is unset. */
export const TEST_IP_CONFIG: ClientIpConfig = { trustProxy: false, trustedHopsFromEnd: 1 };

/**
 * A fixed secret so a caller (`httpServer.test.ts`) can sign a matching cookie itself, rather than
 * re-deriving one — see that file's `authCookieHeader`. Real config requires 32+ characters
 * (`config.ts`'s `loadSessionConfig`); this is long enough to be realistic without meaning anything.
 */
export const TEST_SESSION_SECRET = "test-only-session-secret-do-not-use-in-prod!!!!";

// §7 renderings deps are irrelevant to most callers (transport- or gate-level tests only), so
// they're stubbed out identically wherever a full `ApiDeps` literal is needed.
export function fakeRenderingDeps(): Pick<ApiDeps, "formattingStore" | "conversionStore" | "saveRendering" | "approveRendering"> {
  return {
    formattingStore: { loadAll: async () => [], upsert: async () => {}, listRenderedKeys: async () => new Set() },
    conversionStore: { loadAll: async () => [], upsert: async () => {}, listConvertedKeys: async () => new Set() },
    saveRendering: { run: async () => ({ itemId: "x:1", type: "x", channel: "x" }) } as unknown as ApiDeps["saveRendering"],
    approveRendering: { run: async () => undefined } as unknown as ApiDeps["approveRendering"],
  };
}

/** §8 board deps, likewise irrelevant to transport- or gate-level tests. */
export function fakeBoardDeps(): Pick<ApiDeps, "loadBoard" | "saveOutletOverride" | "markDelivery" | "sendToOutlet" | "reconcilePublished"> {
  return {
    loadBoard: async (itemId: string) => ({ itemId, groups: [], unconverted: [] }),
    saveOutletOverride: { run: async () => undefined } as unknown as ApiDeps["saveOutletOverride"],
    markDelivery: { run: async () => {} } as unknown as ApiDeps["markDelivery"],
    reconcilePublished: async () => ({ reconciled: 0, retired: 0, pending: 0 }),
    sendToOutlet: async () => ({ sent: 0, failed: 0 }),
  };
}

/** §10 conversion/format triggers, likewise irrelevant to transport- or gate-level tests. */
export function fakeConvertFormatDeps(): Pick<ApiDeps, "prepareConversionRun" | "formatVariants"> {
  return {
    prepareConversionRun: { run: async () => ({ worksheetPath: "", pending: 0 }) } as unknown as ApiDeps["prepareConversionRun"],
    formatVariants: { run: async () => ({ renderings: [], warnings: [] }) } as unknown as ApiDeps["formatVariants"],
  };
}

/**
 * A full `ApiDeps` covering every route with harmless in-memory doubles. Shared by
 * `httpServer.test.ts` (real HTTP, transport-level tests) and `gate.test.ts` (direct `handleApi`
 * calls, exercising the session gate across every route) so the two never maintain separate stub
 * sets that could quietly drift apart on what a newly added route needs.
 *
 * `session` defaults to `undefined` — no session, the "secure by default" gate.test.ts's
 * `unauthenticatedDeps()` relies on; a caller that needs to be authenticated sets it explicitly
 * (`gate.test.ts`'s `authenticatedDeps()`), and `httpServer.test.ts`'s real HTTP requests get their
 * `session` recomputed per request by `HttpServer` regardless of what this default holds.
 */
export function fakeDeps(): ApiDeps {
  return {
    translationStore: { loadAll: async () => [{ itemId: "x:1", source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" }], upsert: async () => {}, listTranslatedIds: async () => new Set() },
    saveTranslation: { run: async () => ({ itemId: "x:1", promoted: false }) } as unknown as ApiDeps["saveTranslation"],
    publishOne: async () => ({ uploaded: 0, updated: 0, failed: 0, failures: [], byDrive: {} }),
    storageMode: "cloud",
    ...fakeRenderingDeps(),
    ...fakeBoardDeps(),
    ...fakeConvertFormatDeps(),
    loadStatus: async () => ({ storageMode: "cloud", funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 }, sync: { synced: 0, needsRepublish: 0, unpublished: 0 }, availableTargets: ["local"], integrations: [], sheetLinks: {}, dbEnv: "development" }),
    loadPublishState: async () => [],
    loadTranslations: async () => [{ itemId: "x:1", source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" }],
    xMaxWeighted: 280,
    loadQuota: async () => ({ error: "not configured" }),
    login: async () => ({ ok: false, retryAfterMs: 0 }),
    sessionConfig: { secret: TEST_SESSION_SECRET, ttlMs: SESSION_TTL_MS },
    ipConfig: TEST_IP_CONFIG,
    clientIp: undefined,
    session: undefined,
  };
}
