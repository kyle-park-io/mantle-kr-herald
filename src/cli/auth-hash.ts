import "./registerErrorHandler";
import { stdin, stdout } from "node:process";
import { ask } from "./prompt";
import { hashPassword, verifyPassword } from "../domain/auth/password";

/**
 * Produces the `HERALD_AUTH_PASSWORD_HASH` line for `.env`.
 *
 * The password is never taken as an argument: `pnpm auth:hash 'secret'` would leave it in shell
 * history and, for the moment it runs, in every process listing on the machine. Typed at a prompt
 * or piped in, it stays out of both.
 */

/** Minimum length. One shared credential, reachable from the internet, in front of sends that cannot be recalled. */
const MIN_LENGTH = 12;

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

const prompt = (question: string, hidden = false) =>
  ask(question, { hidden, input: stdin, output: stdout });

if (!stdin.isTTY) {
  // Piped: the password on stdin, nothing to prompt for and nothing to confirm.
  const password = await readPiped();
  if (password.length < MIN_LENGTH) {
    throw new Error(`Password must be at least ${MIN_LENGTH} characters (got ${password.length}).`);
  }
  console.log(await hashPassword(password));
} else {
  const username = (await prompt("아이디: ")).trim();
  if (!username) throw new Error("Username must not be empty.");

  const password = await prompt("비밀번호: ", true);
  if (password.length < MIN_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_LENGTH} characters (got ${password.length}). ` +
        "One shared account in front of irreversible publishing is worth a long one.",
    );
  }
  const again = await prompt("비밀번호 확인: ", true);
  if (password !== again) throw new Error("The two entries do not match. Nothing was written.");

  const hash = await hashPassword(password);
  // Round-trip before printing: a hash that cannot verify its own password would lock the team out
  // with no way to tell why, and the check costs one derivation.
  if (!(await verifyPassword(password, hash))) {
    throw new Error("Generated hash failed to verify. Refusing to print it.");
  }

  console.log("\n.env에 아래 두 줄을 넣으세요:\n");
  console.log(`HERALD_AUTH_USERNAME=${username}`);
  console.log(`HERALD_AUTH_PASSWORD_HASH=${hash}`);
  console.log("\n비밀번호 자체는 어디에도 저장되지 않습니다. 잊으면 다시 만들어야 합니다.");
}
