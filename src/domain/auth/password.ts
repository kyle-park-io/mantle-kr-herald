import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * scrypt rather than a bare SHA: a single human-chosen password behind one account is exactly the
 * case a fast hash loses. scrypt is deliberately slow and memory-hard (RFC 7914), so an attacker
 * holding a leaked hash pays for every guess.
 *
 * Node ships it, which is the other half of the choice — argon2 and bcrypt both mean a native
 * module, and this repo has one runtime dependency.
 */
const N = 65536; // 2^16 — roughly 100–200ms per derivation on the machines this runs on
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** 128 * N * r is scrypt's working set (~67MB here); Node's 32MB default would refuse outright. */
const MAX_MEM = 128 * N * R * 2;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * `scrypt$N$r$p$salt$key`, all base64. The parameters travel with the hash so raising the cost
 * later does not invalidate every credential already issued — an old hash still verifies under the
 * parameters it was made with.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

const isPositiveInt = (value: number) => Number.isInteger(value) && value > 0;

export interface DecodedPasswordHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}

/**
 * Parses `scrypt$N$r$p$salt$key`, or `undefined` when the encoding cannot authenticate anyone.
 *
 * Every field is checked before a single byte is derived, because a damaged encoding must refuse
 * the login rather than crash it — and, in one case, rather than *grant* it: an encoding whose key
 * is empty compares two zero-length buffers, and `timingSafeEqual` calls that a match. A truncated
 * `HERALD_AUTH_PASSWORD_HASH` would have accepted any password at all.
 *
 * The parameter bounds also keep an env var from asking Node for an absurd allocation.
 *
 * Exported so the config loader can refuse a bad `HERALD_AUTH_PASSWORD_HASH` at startup using
 * exactly these rules. Two copies of "what counts as a usable hash" is the failure this prevents:
 * on 2026-08-05 a hash the loader accepted and this function rejected produced a deployment that
 * started cleanly and answered 401 to every login forever, with nothing anywhere saying why. The
 * repo's own test fixture was an instance of it — a 4-byte salt and a 4-byte key, structurally
 * `scrypt$…` and cryptographically unusable.
 */
export function decodePasswordHash(encoded: string): DecodedPasswordHash | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!isPositiveInt(n) || !isPositiveInt(r) || !isPositiveInt(p)) return undefined;
  // scrypt requires N to be a power of two greater than 1; the ceiling caps the working set.
  if (n < 16384 || n > 1048576 || (n & (n - 1)) !== 0) return undefined;
  if (r > 32 || p > 16) return undefined;

  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length < 8 || expected.length < 16 || expected.length > 64) return undefined;

  return { n, r, p, salt, expected };
}

/** Whether `encoded` is a hash this module could actually verify a password against. */
export function isPasswordHash(encoded: string): boolean {
  return decodePasswordHash(encoded) !== undefined;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const decoded = decodePasswordHash(encoded);
  if (!decoded) return false;

  const { n, r, p, salt, expected } = decoded;
  try {
    const derived = await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    // scrypt rejects parameter combinations the bounds above do not enumerate. Refuse, don't throw.
    return false;
  }
}
