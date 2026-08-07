/**
 * Where `pnpm deploy:smoke` gets the account it logs in as.
 *
 * It only ever prompted, which made the one command that proves a deployment actually works the one
 * command nothing automated could run — not CI, not a deploy script, not an agent finishing a
 * release. `docs/ko/deploy.md` lists it as step 3 of every redeploy, so in practice it is the step
 * that gets skipped.
 *
 * The environment is checked first and the prompt stays as the interactive fallback, so a human
 * running it by hand sees no change at all.
 */

const USERNAME_VAR = "HERALD_SMOKE_USERNAME";
const PASSWORD_VAR = "HERALD_SMOKE_PASSWORD";

export type SmokeCredentials =
  | { kind: "env"; username: string; password: string }
  | { kind: "prompt" }
  | { kind: "refuse"; reason: string };

/**
 * Both variables set → use them. Neither set → prompt. Anything in between → refuse.
 *
 * The refusal is the point of the function. Half-configured secrets would otherwise fall through to
 * a prompt on a runner with no tty and hang until the job times out — which reads as a broken
 * deployment rather than as a missing secret. A set-but-blank value is treated the same way: someone
 * believed they had configured it, and silently prompting instead would hide that they had not.
 *
 * The username is trimmed and the password never is: a trailing space in a pasted username is a
 * typo, in a password it is a character.
 */
export function smokeCredentials(env: Record<string, string | undefined>): SmokeCredentials {
  const rawUsername = env[USERNAME_VAR];
  const rawPassword = env[PASSWORD_VAR];

  if (rawUsername === undefined && rawPassword === undefined) return { kind: "prompt" };

  const username = rawUsername?.trim() ?? "";
  const password = rawPassword ?? "";

  const missing: string[] = [];
  if (username === "") missing.push(USERNAME_VAR);
  if (password.trim() === "") missing.push(PASSWORD_VAR);

  if (missing.length > 0) {
    return {
      kind: "refuse",
      reason:
        `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing or blank while the other is set. ` +
        `Set both to run without a prompt, or unset both to be asked interactively — refusing to prompt for ` +
        `half of a configuration that was meant to be non-interactive.`,
    };
  }

  return { kind: "env", username, password };
}
