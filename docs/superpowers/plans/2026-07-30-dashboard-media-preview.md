# Dashboard media preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering a photo marker's url in the review panes shows the image, and an editing box that
contains markers says where the preview lives.

**Architecture:** One pure module parses the markers already present in the reviewed text; one
component renders that text with each photo marker wrapped in the dashboard's existing CSS-only
hover-card pattern. Two screens consume it. No server, API, or storage change — the url is already in
the string the frontend receives.

**Tech Stack:** React 19 + TypeScript + Tailwind v4 (`web/`), Vitest + jsdom + `@testing-library/react`
for component tests.

Spec: `docs/superpowers/specs/2026-07-30-dashboard-media-preview-design.md`

## Global Constraints

- **Frontend only.** No file under `src/` changes. No new runtime dependency (the backend stays
  zod-only; the frontend adds nothing).
- **Marker definitions must mirror `src/domain/media/sourceMedia.ts`.** Photo = `^!\[\]\(([^)]+)\)[ \t]*$`,
  video = `^\[영상\](?:[ \t]+(\S+))?[ \t]*$` — both anchored to a whole line. The frontend cannot import
  from `src/` (separate tsconfig; `src/` has no DOM lib), so the patterns are duplicated and a comment
  in each place names the other.
- **Editing textareas are not modified.** No overlay, no change to `value`, `onChange`, size, or any
  handler. A notice may be added *outside* the textarea.
- **Video has no preview** — the `[영상]` marker carries no url. Do not fetch thumbnails from
  `items.json`.
- **UI copy is Korean; code, comments and commit messages are English.**
- Test file placement: pure modules → `tests/web/*.test.ts`; component tests (JSX/DOM) →
  `web/tests/*.test.tsx` with a `// @vitest-environment jsdom` first line. Only `web/tsconfig.json`
  has `jsx` + the DOM lib.
- Verification commands: `pnpm test`, `pnpm typecheck`, `pnpm typecheck:web`, `pnpm build:web`.
- Branch `feat/dashboard-media-preview` already exists and holds the spec commit. Work there; finish
  with a PR (never merge locally).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `web/src/media.ts` (create) | Pure: split a stored string into text/photo segments; count photo and video markers. No React. |
| `web/src/components/MarkerText.tsx` (create) | `MarkerText` (text + hover preview) and `MediaEditNotice` (the editor hint). |
| `web/src/components/TranslationDetail.tsx` (modify) | 1차: source pane renders `MarkerText`; notice under the korean textarea. |
| `web/src/components/OutletCard.tsx` (modify) | 2차: `Source` renders `MarkerText`; notice under the group textarea and the per-room fork textarea. |
| `tests/web/media.test.ts` (create) | Parsing invariants, including the round-trip. |
| `web/tests/MarkerText.test.tsx` (create) | Rendering, hover target, image failure, notice. |
| `web/tests/OutletCard.test.tsx` (modify) | 2차 wiring. |
| `web/tests/TranslationDetail.test.tsx` (create) | 1차 wiring. |

---

### Task 1: Marker parsing module

**Files:**
- Create: `web/src/media.ts`
- Test: `tests/web/media.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type MediaSegment = { kind: "text"; text: string } | { kind: "photo"; text: string; url: string }`
  - `export function splitMediaMarkers(text: string): MediaSegment[]` — segments in document order.
    **Invariant:** `splitMediaMarkers(t).map(s => s.text).join("\n") === t`.
  - `export function countMediaMarkers(text: string): { photos: number; videos: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/web/media.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { countMediaMarkers, splitMediaMarkers } from "../../web/src/media";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";
const PHOTO = `![](${URL})`;

describe("splitMediaMarkers", () => {
  it("returns a single text segment when there is no marker", () => {
    expect(splitMediaMarkers("한 줄\n두 줄")).toEqual([{ kind: "text", text: "한 줄\n두 줄" }]);
  });

  it("splits a photo marker out of the text around it", () => {
    expect(splitMediaMarkers(`본문\n\n${PHOTO}`)).toEqual([
      { kind: "text", text: "본문\n" },
      { kind: "photo", text: PHOTO, url: URL },
    ]);
  });

  it("keeps every marker of a thread, in order", () => {
    const other = "https://pbs.twimg.com/media/OTHER.jpg";
    const segments = splitMediaMarkers(`첫 트윗\n\n${PHOTO}\n\n---\n\n둘째 트윗\n\n![](${other})`);
    expect(segments.filter((s) => s.kind === "photo")).toEqual([
      { kind: "photo", text: PHOTO, url: URL },
      { kind: "photo", text: `![](${other})`, url: other },
    ]);
  });

  it("rejoining the segments with a newline reproduces the input exactly", () => {
    const text = `첫 줄\n\n${PHOTO}\n\n마지막 줄\n\n[영상]`;
    expect(splitMediaMarkers(text).map((s) => s.text).join("\n")).toBe(text);
  });

  it("leaves a video marker as plain text — it carries no url to preview", () => {
    expect(splitMediaMarkers("[영상]")).toEqual([{ kind: "text", text: "[영상]" }]);
  });

  it("ignores an image that is not alone on its line", () => {
    const inline = `문장 안의 ${PHOTO} 이미지`;
    expect(splitMediaMarkers(inline)).toEqual([{ kind: "text", text: inline }]);
  });
});

describe("countMediaMarkers", () => {
  it("counts photos and videos separately", () => {
    expect(countMediaMarkers(`${PHOTO}\n\n[영상]\n\n[영상] https://video.mp4`)).toEqual({
      photos: 1,
      videos: 2,
    });
  });

  it("counts nothing for text with no marker", () => {
    expect(countMediaMarkers("[결과 확인]\n평범한 본문")).toEqual({ photos: 0, videos: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/web/media.test.ts`
Expected: FAIL — cannot resolve `../../web/src/media`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/media.ts`:

```ts
/**
 * Media markers as they appear in the reviewed text. `XContentSource.mediaMarkers()` writes them,
 * `emit()` strips them (`stripMedia`), and the send path reads the photo urls back out — so the text
 * on these screens is the only place a reviewer can see that a post carries media.
 *
 * These two patterns MIRROR `PHOTO_LINE`/`VIDEO_LINE` in `src/domain/media/sourceMedia.ts` and must
 * be changed together. The frontend cannot import them: `src/` is a Node pipeline typechecked without
 * the DOM lib, and `web/` builds on its own tsconfig. A looser pattern here would preview something
 * the send path does not treat as media, which is worse than not previewing at all.
 */
const PHOTO_LINE = /^!\[\]\(([^)]+)\)[ \t]*$/;
const VIDEO_LINE = /^\[영상\](?:[ \t]+\S+)?[ \t]*$/;

export type MediaSegment =
  | { kind: "text"; text: string }
  | { kind: "photo"; text: string; url: string };

/**
 * Split stored text into runs of ordinary text and the photo markers between them.
 *
 * Segments are line-aligned, so rejoining them with a single newline reproduces the input exactly —
 * that invariant is what lets the renderer show the reviewed text unchanged.
 */
export function splitMediaMarkers(text: string): MediaSegment[] {
  const segments: MediaSegment[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) segments.push({ kind: "text", text: buffer.join("\n") });
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const photo = PHOTO_LINE.exec(line);
    if (photo) {
      flush();
      segments.push({ kind: "photo", text: line, url: photo[1] });
      continue;
    }
    buffer.push(line);
  }
  flush();
  return segments;
}

/** How much media the text carries, by kind. Only photos can be previewed. */
export function countMediaMarkers(text: string): { photos: number; videos: number } {
  let photos = 0;
  let videos = 0;
  for (const line of text.split("\n")) {
    if (PHOTO_LINE.test(line)) photos += 1;
    else if (VIDEO_LINE.test(line)) videos += 1;
  }
  return { photos, videos };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/web/media.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/media.ts tests/web/media.test.ts
git commit -m "feat(web): parse media markers out of reviewed text"
```

---

### Task 2: MarkerText and MediaEditNotice components

**Files:**
- Create: `web/src/components/MarkerText.tsx`
- Test: `web/tests/MarkerText.test.tsx`

**Interfaces:**
- Consumes: `splitMediaMarkers`, `countMediaMarkers` from `web/src/media.ts` (Task 1). `MediaSegment`
  is inferred from the return type — do not import it, an unused import fails the build.
- Produces:
  - `export function MarkerText({ text }: { text: string }): JSX.Element` — renders `text` verbatim;
    each photo marker also previews its image on hover.
  - `export function MediaEditNotice({ text, where }: { text: string; where: string }): JSX.Element | null`
    — `where` is the Korean name of the pane that has the preview (`"원문"`, `"변환 원문"`). Returns
    `null` when `text` has no marker.

- [ ] **Step 1: Write the failing test**

Create `web/tests/MarkerText.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkerText, MediaEditNotice } from "../src/components/MarkerText";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";
const PHOTO = `![](${URL})`;

afterEach(cleanup);

describe("MarkerText", () => {
  it("renders the reviewed text unchanged", () => {
    const text = `본문 첫 줄\n\n${PHOTO}`;
    const { container } = render(<MarkerText text={text} />);
    expect(container.textContent).toBe(text);
  });

  it("gives each photo marker an image to preview", () => {
    const other = "https://pbs.twimg.com/media/OTHER.jpg";
    const { container } = render(<MarkerText text={`${PHOTO}\n\n---\n\n![](${other})`} />);
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([URL, other]);
  });

  it("previews nothing when there is no photo marker", () => {
    const { container } = render(<MarkerText text={"[영상]\n\n평범한 본문\n[결과 확인]"} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("says so when the image cannot be loaded, instead of showing a broken box", () => {
    const { container } = render(<MarkerText text={PHOTO} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toContain("이미지를 불러오지 못했습니다");
  });
});

describe("MediaEditNotice", () => {
  it("renders nothing when the edited text carries no media", () => {
    const { container } = render(<MediaEditNotice text="사진 없는 번역문" where="원문" />);
    expect(container.textContent).toBe("");
  });

  it("points at the pane that has the preview", () => {
    const { container } = render(<MediaEditNotice text={`번역문\n\n${PHOTO}`} where="변환 원문" />);
    expect(container.textContent).toContain("변환 원문");
  });

  it("says video has no preview at all", () => {
    const { container } = render(<MediaEditNotice text={"번역문\n\n[영상]"} where="원문" />);
    expect(container.textContent).toContain("영상은 미리보기가 없습니다");
    expect(container.textContent).not.toContain("이미지 미리보기");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test web/tests/MarkerText.test.tsx`
Expected: FAIL — cannot resolve `../src/components/MarkerText`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/components/MarkerText.tsx`:

```tsx
import { Fragment, useState } from "react";
import { countMediaMarkers, splitMediaMarkers } from "../media";

/**
 * The marker line, still spelled exactly as it is stored, with the image behind its url one hover
 * away. The url stays visible on purpose: it is what the reviewer reads today, and the send path
 * uploads that exact string.
 */
function PhotoMarker({ text, url }: { text: string; url: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="group/media relative cursor-help text-mint">
      {text}
      <span className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden rounded-lg border border-line bg-surface p-1.5 shadow-lg group-hover/media:block">
        {failed ? (
          <span className="block w-64 px-1 py-0.5 text-[12px] leading-relaxed text-muted">
            이미지를 불러오지 못했습니다
          </span>
        ) : (
          <img
            src={url}
            alt=""
            className="block max-h-64 w-80 max-w-[70vw] object-contain"
            onError={() => setFailed(true)}
          />
        )}
      </span>
    </span>
  );
}

/** Reviewed text, rendered verbatim, with a hover preview on every photo marker. */
export function MarkerText({ text }: { text: string }) {
  const segments = splitMediaMarkers(text);
  return (
    <>
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {/* The split is line-aligned, so the newline between two segments belongs back here. */}
          {i > 0 && "\n"}
          {segment.kind === "photo" ? (
            <PhotoMarker text={segment.text} url={segment.url} />
          ) : (
            segment.text
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Why this box has no preview. A `<textarea>` cannot host a hover target on a substring, so the
 * preview lives in the read-only pane and this line says where — but only when the text actually
 * carries media, so a copy without it looks exactly as it did before.
 */
export function MediaEditNotice({ text, where }: { text: string; where: string }) {
  const { photos, videos } = countMediaMarkers(text);
  if (photos + videos === 0) return null;
  return (
    <p className="text-[12px] leading-relaxed text-faint">
      {photos > 0 && `이미지 미리보기는 ${where}에서 확인하세요`}
      {photos > 0 && videos > 0 && " · "}
      {videos > 0 && "영상은 미리보기가 없습니다"}
    </p>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test web/tests/MarkerText.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/MarkerText.tsx web/tests/MarkerText.test.tsx
git commit -m "feat(web): hover preview for a photo marker"
```

---

### Task 3: Wire the 1차 review screen

**Files:**
- Modify: `web/src/components/TranslationDetail.tsx` (source pane at lines 96–101; textarea section at 103–125)
- Test: `web/tests/TranslationDetail.test.tsx` (create)

**Interfaces:**
- Consumes: `MarkerText`, `MediaEditNotice` from Task 2.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `web/tests/TranslationDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TranslationDetail } from "../src/components/TranslationDetail";
import type { Translation } from "../src/types";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";
const PHOTO = `![](${URL})`;

const translation = (o: Partial<Translation> = {}): Translation => ({
  itemId: "x:2081711456320655644",
  source: "x",
  sourceText: `Built from the inside out.\n\n${PHOTO}`,
  koreanText: `맨틀은 이 구조를 내부에서부터 구축했습니다.\n\n${PHOTO}`,
  status: "translated",
  translatedAt: "2026-07-30T00:00:00.000Z",
  ...o,
});

function mount(item: Translation) {
  return render(
    <TranslationDetail
      item={item}
      publishRows={[]}
      availableTargets={["local"]}
      onSave={async () => {}}
      onApprove={async () => {}}
      onUnapprove={async () => {}}
      onPublish={async () => {}}
      onDirtyChange={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("TranslationDetail media", () => {
  it("previews the photo the source post carries", () => {
    const { container } = mount(translation());
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([URL]);
  });

  it("tells the editor where the preview is", () => {
    const { container } = mount(translation());
    expect(container.textContent).toContain("이미지 미리보기는 원문에서 확인하세요");
  });

  it("stays silent for a translation with no media", () => {
    const { container } = mount(translation({ sourceText: "no media", koreanText: "미디어 없음" }));
    expect(container.textContent).not.toContain("미리보기");
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("leaves the textarea holding the stored text, markers included", () => {
    const { container } = mount(translation());
    expect(container.querySelector("textarea")!.value).toBe(translation().koreanText);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test web/tests/TranslationDetail.test.tsx`
Expected: FAIL — 0 images found (the source pane renders a plain string) and the notice text is absent.

- [ ] **Step 3: Write minimal implementation**

In `web/src/components/TranslationDetail.tsx`, add the import:

```tsx
import { MarkerText, MediaEditNotice } from "./MarkerText";
```

Replace the source pane body (currently `{props.item.sourceText}`):

```tsx
        <div className="rounded-xl border border-line bg-surface p-4 text-[15px] leading-relaxed whitespace-pre-wrap text-ink/80 shadow-sm">
          <MarkerText text={props.item.sourceText} />
        </div>
```

And add the notice directly after the `</textarea>` closing tag, still inside the same `<section>`:

```tsx
        <div className="mt-1.5">
          <MediaEditNotice text={korean} where="원문" />
        </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test web/tests/TranslationDetail.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TranslationDetail.tsx web/tests/TranslationDetail.test.tsx
git commit -m "feat(web): preview source photos on the 1차 screen"
```

---

### Task 4: Wire the 2차 board

**Files:**
- Modify: `web/src/components/OutletCard.tsx` (`Source` at lines 516–534; group textarea notice block at 283–318; fork textarea at 991–1004)
- Test: `web/tests/OutletCard.test.tsx` (append a describe block)

**Interfaces:**
- Consumes: `MarkerText`, `MediaEditNotice` from Task 2.
- Produces: nothing other tasks depend on.

The card has three text surfaces. `Source` (변환 원문) is read-only and gets `MarkerText`. The group
textarea and the per-room fork textarea are editable and get the notice — the fork included, because a
forked room's copy carries the same markers and its reviewer has the same question.

- [ ] **Step 1: Write the failing test**

Append to `web/tests/OutletCard.test.tsx`, reusing the file's existing `row`, `group`, `stubFetch` and
`mount` helpers:

```tsx
describe("media markers", () => {
  const URL = "https://pbs.twimg.com/media/HOZMXqPbIAALIE8.jpg";
  const PHOTO = `![](${URL})`;

  beforeEach(() => stubFetch());

  it("previews the photo in the converted source", () => {
    const { container } = mount(group({ text: "그룹 글", rows: [row()] }), { convertedText: `변환 원문\n\n${PHOTO}` });
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([URL]);
  });

  it("tells the group editor where the preview is", () => {
    const { container } = mount(group({ text: `그룹 글\n\n${PHOTO}`, rows: [row()] }));
    expect(container.textContent).toContain("이미지 미리보기는 변환 원문에서 확인하세요");
  });

  it("says nothing when no text on the card carries media", () => {
    const { container } = mount(group({ text: "그룹 글", rows: [row()] }));
    expect(container.textContent).not.toContain("미리보기");
  });
});
```

`mount` currently hardcodes `convertedText="변환 원문"`. Widen it to accept an override, leaving every
existing call unchanged:

```tsx
function mount(g: BoardGroup, o: { convertedText?: string } = {}) {
```

and pass `convertedText={o.convertedText ?? "변환 원문"}` to `<OutletCard>`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test web/tests/OutletCard.test.tsx`
Expected: FAIL — no image in the converted source, notice text absent.

- [ ] **Step 3: Write minimal implementation**

Add the import to `web/src/components/OutletCard.tsx`:

```tsx
import { MarkerText, MediaEditNotice } from "./MarkerText";
```

In `Source`, replace `{convertedText}` with the component:

```tsx
        <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap text-[14px] leading-relaxed text-muted">
          <MarkerText text={convertedText} />
        </div>
```

Add the notice as the last child of the group textarea's existing hint block — the `<div
className="mt-1.5 space-y-1 text-[12px] leading-relaxed text-faint">` that already carries the split
and bold lines, right after its `<p>{CHANNEL_RENDERS_BOLD[channel] ? …}</p>`:

```tsx
          <MediaEditNotice text={fromEditor(text)} where="변환 원문" />
```

Add the same line under the per-room fork textarea, inside the `{props.open && (…)}` block right after
the `</textarea>`:

```tsx
          <div className="mt-1.5">
            <MediaEditNotice text={fromEditor(props.draft)} where="변환 원문" />
          </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test web/tests/OutletCard.test.tsx`
Expected: PASS — the new describe block plus every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/OutletCard.tsx web/tests/OutletCard.test.tsx
git commit -m "feat(web): preview converted-source photos on the 2차 board"
```

---

### Task 5: Verify the whole thing, in a browser and in CI

**Files:**
- No source changes expected. Fix anything this task surfaces.

- [ ] **Step 1: Run the full suite and both typechecks**

```bash
pnpm test
pnpm typecheck
pnpm typecheck:web
```

Expected: all pass. `pnpm typecheck` must stay green — it proves no `src/` file was touched in a way
that breaks the Node build.

- [ ] **Step 2: Build the frontend and start the dashboard**

```bash
pnpm build:web && pnpm serve
```

Expected: serves on `http://localhost:5757`. (There is no hot reload — any later `web/src` edit needs
`pnpm build:web` again.)

- [ ] **Step 3: Check the 1차 screen against real data**

Open `http://localhost:5757`, select an item whose text carries a marker. `x:2081711456320655644` is
the live one; confirm with:

```bash
node -e "const t=require('./output/translations/translations.json');const a=Array.isArray(t)?t:t.translations;console.log(a.filter(x=>/!\[\]\(/.test(x.sourceText)).map(x=>x.itemId))"
```

Verify, with Playwright MCP: hovering the marker url in 원문 shows the image; the notice sits under the
korean textarea; typing in the textarea still works (caret, Korean IME, scroll) and the notice does not
move the box.

- [ ] **Step 4: Check the 2차 board**

Switch to 2차 검수, open the same item's card. Verify: the notice under the group textarea; expanding
`변환 원문 · converted` and hovering a marker shows the image; a room's fork editor shows the notice too.

- [ ] **Step 5: Commit any fixes and open the PR**

```bash
git push -u origin feat/dashboard-media-preview
gh pr create --title "feat(web): preview media markers in the review panes" --body "$(cat <<'EOF'
A post's photos ride through the pipeline inside the reviewed text, as `![](url)` markers written by
`XContentSource.mediaMarkers()`. Until now the dashboard showed the reviewer that url and nothing
else — `web/src` had no media handling at all.

**What a reviewer sees now**

- 1차 원문 and 2차 변환 원문: hovering a marker's url shows the image. The url itself is unchanged.
- An editing box whose text carries a marker says where the preview is; a box without media looks
  exactly as before.

**What deliberately did not change**

- The editing textareas. A `<textarea>` cannot host a hover target on a substring, and the only way
  around it (a mirrored overlay) risks caret, scroll and Korean IME behaviour.
- The copy/destination tabs — `emit()` strips markers before that text exists.
- Server, API, stored fields. This is a frontend-only change.

**Out of scope: video.** The `[영상]` marker carries no url (see `mediaMarkers`), so there is nothing
on screen to preview. The notice says so.

Spec: `docs/superpowers/specs/2026-07-30-dashboard-media-preview-design.md`
EOF
)"
```

---

## Notes for the implementer

- **Do not "improve" the marker regex.** It mirrors `sourceMedia.ts`. If it looks too strict (e.g. it
  rejects an image with alt text, or one sharing a line with prose), that is deliberate: the send path
  would not treat those as media either, and previewing them would lie.
- **`fromEditor` before counting markers in a textarea.** The editor shows a post boundary as `---`;
  `fromEditor` turns it back into the stored spelling. Markers are unaffected either way, but staying
  on the stored form keeps one definition of "the text".
- **jsdom does not load images.** `onError` never fires on its own there — the test triggers it with
  `fireEvent.error`. Do not add a network stub for image urls.
- **`alt=""` makes the image presentational**, so `getByRole("img")` will not find it. The tests query
  the DOM directly, which is why they use `container.querySelectorAll("img")`.
