import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { resolveClientIp } from "../../../src/adapters/web/clientIp";
import type { ClientIpConfig } from "../../../src/config";

/** Just enough of `IncomingMessage` for `resolveClientIp` to read — a socket address and headers. */
function req(socketRemoteAddress: string | undefined, headers: Record<string, string | string[] | undefined> = {}): IncomingMessage {
  return { socket: { remoteAddress: socketRemoteAddress }, headers } as unknown as IncomingMessage;
}

const UNTRUSTED: ClientIpConfig = { trustProxy: false, trustedHopsFromEnd: 1 };
const TRUSTED_1_HOP: ClientIpConfig = { trustProxy: true, trustedHopsFromEnd: 1 };
const TRUSTED_2_HOPS: ClientIpConfig = { trustProxy: true, trustedHopsFromEnd: 2 };

describe("resolveClientIp", () => {
  describe("trustProxy: false (the default)", () => {
    it("reads the socket's own remote address", () => {
      expect(resolveClientIp(req("203.0.113.9"), UNTRUSTED)).toBe("203.0.113.9");
    });

    it("ignores X-Forwarded-For entirely, even a forged one", () => {
      expect(resolveClientIp(req("203.0.113.9", { "x-forwarded-for": "1.2.3.4" }), UNTRUSTED)).toBe("203.0.113.9");
    });

    /**
     * The concrete spoofing scenario the trap in the task exists for: an attacker sending a
     * DIFFERENT forged `X-Forwarded-For` on every single request. With trust off, every one of
     * those requests still resolves to the one real socket address, so per-IP limiting still counts
     * them against the same key rather than being defeated by the header content.
     */
    it("resolves several requests with different forged X-Forwarded-For values to the same key", () => {
      const forged = ["1.1.1.1", "2.2.2.2", "3.3.3.3", "203.0.113.9, 9.9.9.9"];
      const resolved = forged.map((xff) => resolveClientIp(req("203.0.113.9", { "x-forwarded-for": xff }), UNTRUSTED));
      expect(new Set(resolved)).toEqual(new Set(["203.0.113.9"]));
    });

    it("is undefined when the socket itself has no remote address", () => {
      expect(resolveClientIp(req(undefined), UNTRUSTED)).toBeUndefined();
    });
  });

  describe("trustProxy: true", () => {
    // One trusted hop reads the LAST entry — the one the trusted proxy itself appended (its own
    // peer's address). Anything to its left (here, "198.51.100.7") is exactly what a client — or an
    // attacker prepending fake entries in front of a genuine one — could have supplied, and must be
    // ignored regardless of how plausible it looks.
    it("reads the last chain entry when trustedHopsFromEnd is 1", () => {
      const r = req("10.0.0.9" /* the proxy's own socket address — ignored once trust is on */, {
        "x-forwarded-for": "198.51.100.7, 10.0.0.1",
      });
      expect(resolveClientIp(r, TRUSTED_1_HOP)).toBe("10.0.0.1");
    });

    it("reads the second-from-last entry when trustedHopsFromEnd is 2 (two trusted hops)", () => {
      const r = req("10.0.0.2", { "x-forwarded-for": "198.51.100.7, 10.0.0.1, 10.0.0.2" });
      expect(resolveClientIp(r, TRUSTED_2_HOPS)).toBe("10.0.0.1");
    });

    it("trims whitespace around each entry", () => {
      const r = req("10.0.0.9", { "x-forwarded-for": " 198.51.100.7 ,  10.0.0.1 " });
      expect(resolveClientIp(r, TRUSTED_1_HOP)).toBe("10.0.0.1");
    });

    /**
     * The failure modes that must fall back to "no trustworthy IP" (`undefined`) rather than the
     * socket address — which, once trust is on, is the PROXY's own fixed address, not any real
     * client's. Falling back to it would key every distinct visitor under that one value: worse
     * than no per-IP limiting, since it would let one attacker exhaust everyone's shared allowance.
     */
    it("is undefined, not the socket address, when the header is entirely missing", () => {
      expect(resolveClientIp(req("10.0.0.1"), TRUSTED_1_HOP)).toBeUndefined();
    });

    it("is undefined when the chain is shorter than the configured trusted hop count", () => {
      const r = req("10.0.0.1", { "x-forwarded-for": "198.51.100.7" });
      expect(resolveClientIp(r, TRUSTED_2_HOPS)).toBeUndefined();
    });

    it("is undefined for a header that is present but empty", () => {
      expect(resolveClientIp(req("10.0.0.1", { "x-forwarded-for": "" }), TRUSTED_1_HOP)).toBeUndefined();
    });

    it("takes the first line when Node hands back an array of repeated headers", () => {
      const r = req("10.0.0.1", { "x-forwarded-for": ["198.51.100.7, 10.0.0.1"] });
      expect(resolveClientIp(r, TRUSTED_1_HOP)).toBe("10.0.0.1");
    });
  });
});
