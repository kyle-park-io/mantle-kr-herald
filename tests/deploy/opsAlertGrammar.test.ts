// tests/deploy/opsAlertGrammar.test.ts
//
// The two senders — deploy/herald-notify-failure.sh (bash) and src/shared/notifyOps.ts — write to
// the same Telegram room and cannot share code. notifyOps's own header says it "deliberately
// mirrors that script's env contract"; a resemblance nothing checks is a resemblance that drifts.
// This file is the check.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";
import { escapeTelegramHtml, opsNotice } from "../../src/shared/opsAlertGrammar";

const hook = readFileSync(join(REPO_ROOT, "deploy", "herald-notify-failure.sh"), "utf8");

describe("the two ops senders agree on one grammar", () => {
  it("both ask Telegram for HTML, and neither ever passes MarkdownV2 as a mode", () => {
    // "MarkdownV2" appears in this file only inside a comment explaining why HTML was chosen
    // over it (src/domain/formatting/emitters/telegram.ts:29 records the same reasoning on the
    // TS side) — so a bare /MarkdownV2/ match against the file would fail on real content despite
    // the script never sending it. What actually has to stay true is that send_telegram is never
    // CALLED with "MarkdownV2" (quoted, as a mode argument would be) anywhere in the file.
    expect(hook).toContain('"parse_mode":"%s"');
    expect(hook).toContain('send_telegram "$TEXT" "HTML"');
    expect(hook).not.toContain('"MarkdownV2"');
  });

  it("both escape exactly &, < and >, ampersand first", () => {
    // html_escape's replacements are written `\&amp;`/`\&lt;`/`\&gt;` — a literal backslash before
    // the `&` — not the bare `&amp;` a naive read expects: since bash 5.2, `${s//pat/rep}` treats
    // an unescaped `&` in `rep` as sed does, "the text that just matched", so an unescaped version
    // would substitute `<` with `<lt;` and never insert an ampersand at all (see html_escape's own
    // comment, and the "Verified on this box's bash 5.2.21" note next to it). Matched by exact
    // substring rather than a regex assuming the unescaped spelling, and by position rather than one
    // combined pattern, so this does not silently stop checking order the next time the spelling
    // changes for some other reason.
    const ampIdx = hook.indexOf("s=${s//&/\\&amp;}");
    const ltIdx = hook.indexOf("s=${s//</\\&lt;}");
    const gtIdx = hook.indexOf("s=${s//>/\\&gt;}");
    expect(ampIdx, "html_escape's & replacement not found verbatim — did its spelling change?").toBeGreaterThan(-1);
    expect(ltIdx, "html_escape's < replacement not found verbatim, or it moved before &").toBeGreaterThan(ampIdx);
    expect(gtIdx, "html_escape's > replacement not found verbatim, or it moved before <").toBeGreaterThan(ltIdx);
    expect(escapeTelegramHtml("400 <a> & <b>")).toBe("400 &lt;a&gt; &amp; &lt;b&gt;");
  });

  it("both wrap the detail block in <pre> and lead the pointer with ↳", () => {
    // A bare `hook.toContain("<pre>")` matches the *assembly line* (deploy/herald-notify-failure.sh:651)
    // and nothing else — but it ALSO matches the word "<pre>" inside two comments (:642, :712) and the
    // retry's own tag-stripping (`PLAIN=${TEXT//<pre>/}`, :723). Removing the wrapping from the
    // assembly line alone (`<pre>$(html_escape "$LOG_EXCERPT")</pre>"` → `$(html_escape "$LOG_EXCERPT")`)
    // leaves all three of those other occurrences intact, so that check would stay green while the
    // actual behaviour it claims to guard broke — the exact "incidental substring" failure mode this
    // suite exists to avoid. Matched against the literal assembly expression instead, the same way the
    // escape-order check above matches html_escape's actual lines rather than the word "escape".
    expect(hook).toContain('<pre>$(html_escape "$LOG_EXCERPT")</pre>"');
    // The pointer expression is identical text in BOTH branches of the assembly's if/else (the
    // excerpt branch at :653 and the nothing-captured fallback at :660) — a plain `toContain` is
    // satisfied by either one alone, so dropping the pointer from the excerpt branch specifically
    // (the branch every ordinary alert takes) would stay green as long as the rarer fallback branch
    // still had it. Counted rather than merely found, so both sites are required.
    const pointerExpr = '↳ $(html_escape "$LOG_POINTER")"';
    const pointerCount = hook.split(pointerExpr).length - 1;
    expect(pointerCount, "the pointer must be assembled in both the excerpt branch and the fallback branch").toBe(2);
    const notice = opsNotice({ icon: "ℹ", title: "x-reconcile — 번역 2건 은퇴", lines: ["x:1", "x:2"] });
    expect(notice).toContain("<pre>x:1\nx:2</pre>");
    expect(notice.startsWith("ℹ ")).toBe(true);
  });

  it("escapes the title too, not just the lines", () => {
    const notice = opsNotice({ icon: "⚠", title: "a <b> & c", lines: ["<d>"] });
    expect(notice).toContain("a &lt;b&gt; &amp; c");
    expect(notice).toContain("<pre>&lt;d&gt;</pre>");
    expect(notice).not.toContain("<b>");
  });

  it("omits the block entirely when there are no lines", () => {
    expect(opsNotice({ icon: "ℹ", title: "그냥 한 줄" })).toBe("ℹ 그냥 한 줄");
  });

  it("escapes a fixture carrying <, >, & and a literal &lt; without double-escaping it", () => {
    // The escape order is load-bearing in both directions: & must go first here, or the &amp; it
    // introduces gets escaped again and the reader sees &amp;lt;. A fixture with no entities in it
    // cannot catch that — it was exactly this gap that cost the bash side a fix round. This checks
    // the forward (escape) direction with such a fixture; the full round trip through notifyOps's
    // plain-text retry (which must un-escape in the REVERSE order) is pinned in
    // tests/shared/notifyOps.test.ts, since the un-escape step lives there, not here.
    const fixture = "<x> & &lt; <y>";
    expect(escapeTelegramHtml(fixture)).toBe("&lt;x&gt; &amp; &amp;lt; &lt;y&gt;");
  });
});
