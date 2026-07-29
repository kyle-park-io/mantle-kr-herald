import { timingSafeEqual } from "node:crypto";
import { verifyPassword } from "./password";

/** The one account the dashboard accepts, as configured in the environment. */
export interface Account {
  username: string;
  /** A `scrypt$...` encoding produced by `pnpm auth:hash`. */
  passwordHash: string;
}

export interface SuppliedCredentials {
  username: string;
  password: string;
}

/** Length-independent equality — `timingSafeEqual` throws on a length mismatch, which is itself a tell. */
function equalsInConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still compare something of the right shape so the mismatch costs the same as a match.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Whether the supplied credentials are the configured ones.
 *
 * The password is verified even when the username is already known to be wrong. Returning early
 * would make a bad username answer in under a millisecond and a bad password answer in a few
 * hundred, which tells anyone probing exactly when they have guessed the account name — and with
 * one account, that is half the secret.
 */
export async function checkCredentials(supplied: SuppliedCredentials, account: Account): Promise<boolean> {
  const usernameMatches = equalsInConstantTime(supplied.username, account.username);
  const passwordMatches = await verifyPassword(supplied.password, account.passwordHash);
  return usernameMatches && passwordMatches;
}
