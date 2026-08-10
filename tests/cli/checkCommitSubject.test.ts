// tests/cli/checkCommitSubject.test.ts
//
// The fixtures below are real. The accepted ones are subjects that are on `main` today — including
// the three most Korean legitimate subjects in four hundred, which is what stops this rule from
// being tightened into one that rejects the pipeline's own vocabulary. The rejected ones are the two
// that actually reached `main` on 2026-08-11 and prompted the check.
import { describe, it, expect } from "vitest";
import { checkCommitSubject } from "../../src/cli/check-commit-subject";

/** Real subjects from `main`. Every one of these must stay acceptable. */
const ACCEPTED = [
  "fix(deploy): read the command's own log before systemd's account of it",
  "feat(deploy): catch a deployed credential dying between deploys (#177)",
  "docs(deploy): tie the .env.local warning to the file existing, not its contents (#178)",
  "chore(release): cut v0.4.0",
  "feat(deploy): pnpm deploy:smoke",
  "test(web): cover the liveness route in the gate sweep, and pin that a 401 runs no probe",
  "refactor(doctor): build the probe input in one place, as the module's own header demands",
  "feat(web,api): drop [변환 준비] where the deployment cannot convert",
  "fix(x-article): embed images carried as a [사진] marker, not only ![]",
  "feat(web): let a reviewer withdraw a 되돌리기, not just file one",
  // The most Korean legitimate subject in the history — 22% of its letters. If a future tightening
  // of this rule breaks anything, it breaks this first.
  "feat(web): offer 핀으로 고정하기 on a Telegram room's send",
  "docs: a translation can now end at 게시됨 without being approved",
];

/** The two that reached `main` through the squash-merge gap, and the shapes near them. */
const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ["feat(deploy): 배포본 자격증명이 배포 사이에 죽는 것을 매일 잡는다", "language"],
  ["fix(deploy): 알림이 systemd 얘기 말고 실제로 실패한 것을 말하게 한다", "language"],
  ["Update the alert format", "shape"],
  ["fix: ", "shape"],
  ["   ", "empty"],
];

describe("checkCommitSubject", () => {
  it.each(ACCEPTED)("accepts %s", (subject) => {
    expect(checkCommitSubject(subject)).toBeUndefined();
  });

  it.each(REJECTED)("rejects %s as %s", (subject, code) => {
    expect(checkCommitSubject(subject)?.code).toBe(code);
  });

  it("names the counts, so the author can see how far off the subject is", () => {
    const problem = checkCommitSubject("fix(deploy): 알림이 systemd 얘기 말고 실제로 실패한 것을 말하게 한다");
    expect(problem?.message).toContain("Hangul character(s) against");
    // The fix for this one is a re-title, not a commit amend, and the message has to say so or the
    // author edits the wrong thing.
    expect(problem?.message).toContain("re-title the PR");
  });

  it("does not let digits or a version number stand in for English", () => {
    // Latin *letters*, not characters: `v1.2.3-rc4` is not a sentence in any language.
    expect(checkCommitSubject("fix(x): 되돌리기 v1.2.3-rc4")?.code).toBe("language");
  });

  it("accepts a description with no Hangul at all without counting letters", () => {
    expect(checkCommitSubject("chore: v2")).toBeUndefined();
  });
});
