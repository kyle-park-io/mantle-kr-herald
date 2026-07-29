import { useRef, useState, type FormEvent } from "react";

export interface Credentials {
  username: string;
  password: string;
}

/** One geometry for both fields. Taller than the board's controls: this is the page's only input. */
const FIELD =
  "mt-1.5 block w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-[14px] text-ink " +
  "outline-none transition-[border-color,box-shadow] focus:border-mint focus:ring-[3px] focus:ring-mint/15";

const LABEL = "block text-[12px] font-medium text-muted";

/**
 * Not `btnPrimary` from `buttonStyles.ts`: that geometry is sized for a row of board actions
 * sitting beside each other, and stretched to full width it reads as a thin bar. Same mint and
 * same hover, so the two still agree on what a primary action looks like.
 */
const SUBMIT =
  "mt-6 w-full rounded-lg bg-mint py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-mint-hover " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint " +
  "disabled:cursor-default disabled:opacity-60";

/**
 * Sign-in for the review dashboard.
 *
 * Presentation and form state only — it never decides whether a credential is good. `onSubmit`
 * rejects with the message to show, which keeps the comparison on the server where the hash lives
 * and lets this screen render against a stub while that endpoint does not exist yet.
 */
export function LoginPage({ onSubmit }: { onSubmit: (credentials: Credentials) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    // Empty fields are caught here rather than by disabling the button: a disabled control gives a
    // keyboard user nothing to read about why it will not move, and there are only two fields to
    // point at. Focus goes to the one that is missing so the fix is one keystroke away.
    if (!username.trim()) {
      setError("아이디를 입력해 주세요.");
      usernameRef.current?.focus();
      return;
    }
    if (!password) {
      setError("비밀번호를 입력해 주세요.");
      passwordRef.current?.focus();
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onSubmit({ username: username.trim(), password });
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      // Select rather than clear: retyping starts immediately, and a cleared field looks like the
      // form threw the attempt away rather than refused it.
      passwordRef.current?.select();
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center px-6 py-16">
      <div className="w-full max-w-[352px]">
        {/* Product above, surface below — the two lines a returning reviewer needs to know they
            are at the right door, and nothing else. */}
        <header className="mb-7">
          <p className="eyebrow">Mantle KR Herald</p>
          <h1 className="mt-3 text-[30px] font-bold leading-none tracking-[-0.03em] text-ink">Review Dashboard</h1>
        </header>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="rounded-2xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(23,24,27,0.04),0_10px_28px_-14px_rgba(23,24,27,0.12)]"
        >
          <div>
            <label htmlFor="login-username" className={LABEL}>
              아이디
            </label>
            <input
              id="login-username"
              ref={usernameRef}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the page exists to take this field
              autoFocus
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              className={FIELD}
            />
          </div>

          <div className="mt-4">
            <label htmlFor="login-password" className={LABEL}>
              비밀번호
            </label>
            <input
              id="login-password"
              ref={passwordRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              className={FIELD}
            />
          </div>

          {error && (
            <p
              id="login-error"
              role="alert"
              className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] leading-snug text-red-600"
            >
              {error}
            </p>
          )}

          <button type="submit" disabled={pending} className={SUBMIT}>
            {pending ? "확인 중…" : "로그인"}
          </button>
        </form>
      </div>
    </main>
  );
}
