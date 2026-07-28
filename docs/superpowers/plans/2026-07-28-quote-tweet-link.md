# Quote-tweet Link Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a quote tweet's URL from `quoted_tweet.url` and surface it inline at the end of the tweet text (where a "↓" points), so the review doc has a clickable link instead of a dangling "↓".

**Architecture:** A schema binding change plus a small pure helper in `src/adapters/twitterapi/schemas.ts`; the URL rides `SourceTweet.text` through collection into the translation with no other plumbing. Fully covered by `normalizeTweet` unit tests.

**Tech Stack:** TypeScript (ESM), zod, vitest.

## Global Constraints

- Only `src/adapters/twitterapi/schemas.ts` (and its test) changes. No new model fields, no dashboard changes, no `expandUrls`/media/article changes.
- `isQuote` behavior is preserved exactly (`quoted_tweet` present → true).
- Append **link only**, never the quoted tweet's own text.
- De-dup: never append a URL the text already contains, nor when the text already contains the quoted tweet's id (a t.co-expanded form).
- Repo is PUBLIC — tests use placeholder handles/ids only.
- Ends green: `pnpm test` and `pnpm exec tsc --noEmit`.

---

### Task 1: Capture and append the quoted-tweet link

**Files:**
- Modify: `src/adapters/twitterapi/schemas.ts` (bind `quoted_tweet` fields; add `appendQuotedUrl`; wire into `normalizeTweet`)
- Test: `tests/adapters/schemas.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `TweetRaw` (already parses the tweet), `expandUrls` (already imported).
- Produces: no new exports; `normalizeTweet`'s output `text` gains an appended quoted URL when applicable. The existing `rawTweet` fixture (which carries a `quoted_tweet.url`) now yields text with the URL appended — no existing test asserts that fixture's `text`, so none break.

- [ ] **Step 1: Write the failing tests** — append to `tests/adapters/schemas.test.ts`:

```ts
describe("normalizeTweet — quoted-tweet link", () => {
  const base = {
    id: "1",
    url: "https://x.com/Mantle_Official/status/1",
    createdAt: "Mon Jun 29 05:58:17 +0000 2026",
    author: { userName: "Mantle_Official" },
  };

  it("appends the quoted tweet's url after the text when it is not already there", () => {
    const t = normalizeTweet({
      ...base,
      text: "The full breakdown ↓",
      quoted_tweet: { id: "999", url: "https://x.com/nansen_ai/status/999" },
    });
    expect(t.text).toBe("The full breakdown ↓\nhttps://x.com/nansen_ai/status/999");
    expect(t.isQuote).toBe(true);
  });

  it("does not duplicate a quoted url the text already contains", () => {
    const t = normalizeTweet({
      ...base,
      text: "see https://x.com/nansen_ai/status/999",
      quoted_tweet: { id: "999", url: "https://x.com/nansen_ai/status/999" },
    });
    expect(t.text).toBe("see https://x.com/nansen_ai/status/999");
  });

  it("does not append when the text already contains the quoted tweet's id (t.co-expanded)", () => {
    const t = normalizeTweet({
      ...base,
      text: "context https://twitter.com/nansen_ai/status/999",
      quoted_tweet: { id: "999", url: "https://x.com/nansen_ai/status/999" },
    });
    expect(t.text).toBe("context https://twitter.com/nansen_ai/status/999");
  });

  it("leaves text unchanged when the quoted tweet has no url (still isQuote)", () => {
    const t = normalizeTweet({ ...base, text: "hi", quoted_tweet: { id: "999" } });
    expect(t.text).toBe("hi");
    expect(t.isQuote).toBe(true);
  });

  it("leaves text unchanged and isQuote false when there is no quoted tweet", () => {
    const t = normalizeTweet({ ...base, text: "hi" });
    expect(t.text).toBe("hi");
    expect(t.isQuote).toBe(false);
  });

  it("tolerates an unknown extra field on quoted_tweet (passthrough)", () => {
    const t = normalizeTweet({
      ...base,
      text: "hi",
      quoted_tweet: { id: "999", url: "https://x.com/a/status/999", futureKey: "x" },
    });
    expect(t.text).toBe("hi\nhttps://x.com/a/status/999");
  });
});
```

- [ ] **Step 2: Run the new tests — expect FAIL**

Run: `pnpm exec vitest run tests/adapters/schemas.test.ts -t "quoted-tweet link"`
Expected: FAIL (text is not appended yet).

- [ ] **Step 3: Bind the `quoted_tweet` fields** in `src/adapters/twitterapi/schemas.ts`. Replace the line `quoted_tweet: z.unknown().nullable().optional(),` with:

```ts
    quoted_tweet: z
      .object({ url: z.string().nullable().optional(), id: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
```

- [ ] **Step 4: Add the `appendQuotedUrl` helper** in the same file, just above `normalizeTweet`:

```ts
/**
 * Surface the quoted tweet's link at the end of the text (where a "↓" typically points), unless it
 * is already present — either as the URL itself or as a t.co the API expanded to the same tweet id.
 * Link only: the quoted tweet's own text is never inlined.
 */
function appendQuotedUrl(text: string, quoted?: { url?: string | null; id?: string | null } | null): string {
  const url = quoted?.url ?? undefined;
  if (!url) return text;
  if (text.includes(url)) return text;
  if (quoted?.id && text.includes(quoted.id)) return text;
  return `${text}\n${url}`;
}
```

- [ ] **Step 5: Wire it into `normalizeTweet`** — change the `text` line from
`text: expandUrls(t.text, t.entities?.urls ?? undefined),` to:

```ts
    text: appendQuotedUrl(expandUrls(t.text, t.entities?.urls ?? undefined), t.quoted_tweet),
```

- [ ] **Step 6: Run the tests — expect PASS**

Run: `pnpm exec vitest run tests/adapters/schemas.test.ts && pnpm exec tsc --noEmit`
Expected: PASS (all schema tests, including the pre-existing ones), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/twitterapi/schemas.ts tests/adapters/schemas.test.ts
git commit -m "feat(collect): capture quote-tweet url and append it to the tweet text"
```

---

## Self-review

- Spec coverage: schema binding (Step 3), `appendQuotedUrl` incl. de-dup (Step 4), `normalizeTweet` wiring (Step 5), all six spec test cases (Step 1). ✅
- Placeholder scan: none — all code is concrete.
- Type consistency: `appendQuotedUrl(text, quoted)` accepts the parsed `t.quoted_tweet` shape (`{ url?, id? } & passthrough | null | undefined`).
- Global constraint honored: only `schemas.ts` + its test change; `isQuote` untouched; link-only.

## Operational follow-up (manual, after merge — not a task)

Re-collect the recent Mantle window so existing keepers pick up their quoted links, then re-prepare/translate as needed. Operator step, not automated here.
