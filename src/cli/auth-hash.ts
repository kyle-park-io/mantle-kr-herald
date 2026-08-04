import "./registerErrorHandler";
import { stdin, stderr } from "node:process";
import { ask } from "./prompt";
import { hashPassword } from "../domain/auth/password";
import { interactiveAuthHash, MIN_PASSWORD_LENGTH } from "./authHash";

/**
 * Produces the `HERALD_AUTH_PASSWORD_HASH` line for `.env`.
 *
 * The password is never taken as an argument: `pnpm auth:hash 'secret'` would leave it in shell
 * history and, for the moment it runs, in every process listing on the machine. Typed at a prompt
 * or piped in, it stays out of both.
 *
 * Everything the interactive path does lives in `authHash.ts`, because this file runs on import
 * (top-level await) and so cannot be imported by a test — the same split that produced `prompt.ts`.
 */

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

if (!stdin.isTTY) {
  // Piped: the password on stdin, nothing to prompt for and nothing to confirm. Note this path never
  // had a username either — further evidence that it was only ever there to print a second line.
  const password = await readPiped();
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`);
  }
  console.log(await hashPassword(password));
} else {
  const lines = await interactiveAuthHash((question, hidden = false) =>
    ask(question, { hidden, input: stdin, output: stderr }),
  );
  for (const line of lines) console.log(line);
}
