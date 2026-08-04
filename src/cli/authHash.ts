import { hashPassword, verifyPassword } from "../domain/auth/password";

/** Minimum length. One shared credential, reachable from the internet, in front of sends that cannot be recalled. */
export const MIN_PASSWORD_LENGTH = 12;

export type Ask = (question: string, hidden?: boolean) => Promise<string>;

/**
 * scrypt injected so the tests can drive the flow without paying for a ~67MB derivation per case.
 * The real functions are the default, and one test uses them so the wiring itself is covered.
 */
export interface HashFunctions {
  hash?: (password: string) => Promise<string>;
  verify?: (password: string, encoded: string) => Promise<boolean>;
}

/**
 * The interactive half of `pnpm auth:hash`, as the lines to print.
 *
 * Separate from `auth-hash.ts` because that file runs on import (top-level await) and so cannot be
 * imported by a test — the same reason `prompt.ts` was split out of it. Returning lines rather than
 * calling `console.log` is what makes the output assertable.
 *
 * **The username is optional.** It is not an input to the hash: `hashPassword` takes the password
 * alone and salts it randomly, so the account name and the hash are independent — changing
 * `HERALD_AUTH_USERNAME` later leaves an existing hash valid. Asking for it here only ever served to
 * print both `.env` lines together, and on the Vercel path even that is redundant, where DEPLOY.md
 * registers the username with its own `vercel env add --value`. Refusing to continue without one, as
 * this used to, made a convenience look like a requirement.
 */
export async function interactiveAuthHash(ask: Ask, fns: HashFunctions = {}): Promise<string[]> {
  const hash = fns.hash ?? hashPassword;
  const verify = fns.verify ?? verifyPassword;

  const username = (await ask("아이디 (선택 — 비워두면 해시 줄만 출력합니다): ")).trim();

  const password = await ask("비밀번호: ", true);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}). ` +
        "One shared account in front of irreversible publishing is worth a long one.",
    );
  }

  const again = await ask("비밀번호 확인: ", true);
  if (password !== again) throw new Error("The two entries do not match. Nothing was written.");

  const encoded = await hash(password);
  // Round-trip before printing: a hash that cannot verify its own password would lock the team out
  // with no way to tell why, and the check costs one derivation.
  if (!(await verify(password, encoded))) {
    throw new Error("Generated hash failed to verify. Refusing to print it.");
  }

  const lines: string[] = [""];
  if (username) {
    lines.push(".env에 아래 두 줄을 넣으세요:", "", `HERALD_AUTH_USERNAME=${username}`);
  } else {
    lines.push(".env에 아래 줄을 넣으세요:", "");
  }
  lines.push(`HERALD_AUTH_PASSWORD_HASH=${encoded}`);

  if (!username) {
    lines.push(
      "",
      "HERALD_AUTH_USERNAME 은 따로 넣으세요. 아이디는 해시에 들어가지 않으니, 나중에 바꿔도 이 해시는 그대로 씁니다.",
    );
  }
  lines.push("", "비밀번호 자체는 어디에도 저장되지 않습니다. 잊으면 다시 만들어야 합니다.");
  return lines;
}
