import { Fragment, useState, type ReactNode } from "react";
import { countMediaMarkers, splitMediaMarkers } from "../media";
import { InfoPopover } from "./InfoPopover";

/**
 * The shape every media marker takes: the label, with the media one click away and the original one
 * click away too. Photos and videos share it because they are the same thing to a reviewer — a line
 * that stands in for something they have to look at before approving the copy beside it.
 *
 * The raw url is no longer printed. It used to be, on the reasoning that "it is what the reviewer
 * reads today, and the send path uploads that exact string" — but a 60-character CDN url is not
 * something a reviewer reads, and in a thread carrying four photos it was most of the 원문. The url
 * is still there in the stored text, unchanged and still what gets uploaded; this is the read-only
 * pane, and the editable textarea beside it shows the line verbatim.
 *
 * `원본 보기` rather than making the label itself a link: the label toggles the preview open and
 * closed, and one element cannot usefully be both "click to open/close in place" and "click to leave".
 *
 * `preview` is a render prop, not a node, so the caller's element can be wired to this shell's own
 * `onError` — a photo and a clip fail the same way (a dead CDN url) and both have to degrade to a
 * line of Korean rather than a broken box the reviewer has to interpret.
 *
 * Two ways in, on purpose:
 *
 * - **Click or tap ("pin")** opens the `armed`/`open` accordion below, in the document's own flow. A
 *   320px popover on a phone would cover almost all of the source text it sits in, and the preview's
 *   whole job is letting a reviewer compare that text against the photo — cover it and the preview
 *   has no job left. This is the only path touch has, unchanged from before this file grew a second
 *   entry point.
 * - **Hover on a non-touch pointer ("peek")** opens `InfoPopover` — the same floating-panel component
 *   every other hover card on the board now uses. This one was deliberately left out when the others
 *   moved over (`InfoPopover.tsx`'s own top comment used to say so outright) because a floating panel
 *   covers the text exactly like the popover the accordion replaced. It is reused here anyway rather
 *   than a second hand-rolled floating implementation, but only for the *skim* path: `InfoPopover`
 *   renders in its own `position: absolute`/top-layer box, so it never pushes the source text down —
 *   which is exactly what a mouse crossing several markers in a row needs (no text jumping under the
 *   cursor mid-read), and exactly why the click path stays inline instead of also moving to
 *   `InfoPopover` (which WOULD sit over the text once pinned open for study — the one thing this
 *   component exists to avoid).
 *
 * `InfoPopover`'s own trigger already gates hover on `e.pointerType !== "touch"`; nothing here
 * re-checks it. A touch device never fires `pointerenter` at all, so on phones the peek path is
 * simply always closed and pin is the only way in, same as before.
 *
 * A marker that is already pinned open (`open` true) passes `hoverDisabled` to `InfoPopover`, which
 * closes the peek (without unmounting it — see below) the instant a marker gets pinned and blocks
 * `pointerenter` from reopening it until it is un-pinned again. A floating peek stacked over the
 * pinned marker's own inline expansion of the same image would be redundant at best, and two copies
 * of the same `<video autoPlay>` playing on top of each other at worst.
 *
 * The peek and the pin do NOT share a mounted media element — each arms its own copy of `preview(…)`
 * independently (see `armed` and `InfoPopover`'s `keepMounted` below), so skimming a clip by hover and
 * then clicking to pin the same one fetches it twice rather than reusing the peek's buffer. Accepted:
 * the alternative — moving one DOM node between an inline position and a floating one without
 * unmounting it — needs a portal keyed off a ref that only exists once the floating panel has opened
 * at least once, which is a lot of machinery for the less common path (skim several, pin one of the
 * *others* is the more common shape this feature is for).
 *
 * The spec that proposed reviving hover had the preview itself branch popover-vs-inline on the source
 * pane's width, via a `@container` on the caller. This still does not do that — the peek is gated on
 * pointer type, not container width (`InfoPopover` uses a viewport query internally for its own
 * narrow-screen layout, not `@container`; see its top comment for why), so no `@`-variant class exists
 * anywhere in this file, and `TranslationDetail`'s 원문 pane and `OutletCard`'s `Source` still carry no
 * container for one to query. If this component ever does need to know its own container's width, the
 * container has to come back too.
 *
 * Mount is deferred behind `armed` (pin) and `InfoPopover`'s own `keepMounted` (peek) rather than left
 * to `preload="none"`: `autoPlay` overrides that hint the moment a `<video>` exists, and a
 * merely-hidden (`display: none`) element still fetches. A 2차 card can show a dozen markers at once,
 * so mounting eagerly would pull every photo and clip down before anyone opened one. Both are "first
 * ask" signals — a click/tap arms the pin's own copy, a first hover arms the peek's — and each, once
 * armed, stays mounted across further opens/closes of its own kind (collapsing/leaving only hides it),
 * so a second look at either is instant and never re-fetches.
 */
function MediaMarker({
  label,
  url,
  broken,
  preview,
}: {
  label: string;
  url: string;
  broken: string;
  preview: (onError: () => void) => ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);

  const brokenNotice = <span className="block px-1 py-0.5 text-[12px] leading-relaxed text-muted">{broken}</span>;

  return (
    <span className="inline">
      {/*
        The peek. `keepMounted` is what lets a `<video>` inside `preview(...)` survive repeated
        hovers instead of restarting; `hoverDisabled={open}` is what stops it from floating over the
        pin's own inline expansion once this marker is pinned — see the doc comment above for both.
        Wrapping the label button and the link both, not just the label: hovering the link should
        skim the same preview the label does, and `InfoPopover`'s own `targetsEnabledControl` check
        already keeps clicks on either from toggling this panel (see its top comment) — only its
        hover/keyboard path fires here, and the click that lands on the button below still opens the
        pin exactly as it always has.
      */}
      <InfoPopover
        keepMounted
        hoverDisabled={open}
        panelClassName="w-80 p-1.5"
        panel={
          <span data-testid="media-peek">{failed ? brokenNotice : preview(() => setFailed(true))}</span>
        }
      >
        <button
          type="button"
          onClick={() => {
            setArmed(true);
            setOpen((v) => !v);
          }}
          aria-expanded={open}
          className="cursor-pointer text-mint underline-offset-2 hover:underline"
        >
          {label}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="ml-1.5 text-[12px] font-medium text-muted underline-offset-2 hover:text-mint hover:underline"
        >
          원본 보기 ↗
        </a>
      </InfoPopover>
      {armed && (
        <span
          data-testid="media-preview"
          className={`${open ? "block" : "hidden"} mt-1.5 rounded-lg border border-line bg-surface p-1.5`}
        >
          {failed ? brokenNotice : preview(() => setFailed(true))}
        </span>
      )}
    </span>
  );
}

/** A photo marker. `![](url)` is the pre-label spelling, still carried by everything saved before it. */
function PhotoMarker({ text, url }: { text: string; url: string }) {
  return (
    <MediaMarker
      label={text.startsWith("[사진]") ? "[사진]" : "[이미지]"}
      url={url}
      broken="이미지를 불러오지 못했습니다"
      preview={(onError) => (
        <img
          src={url}
          alt=""
          className="block max-h-64 w-full max-w-80 object-contain"
          onError={onError}
        />
      )}
    />
  );
}

/**
 * A video marker, the same shape as the photo one.
 *
 * `muted` is what lets it play at all: browsers block autoplay with sound, so an unmuted `autoPlay`
 * would either sit frozen or, where it is allowed, put audio into a shared office because someone
 * clicked a marker. `playsInline` keeps iOS Safari from taking the clip fullscreen instead of playing
 * it in place, and `loop` suits clips that run a few seconds while the reviewer reads the copy.
 */
function VideoMarker({ url }: { url: string }) {
  return (
    <MediaMarker
      label="[영상]"
      url={url}
      broken="영상을 불러오지 못했습니다"
      preview={(onError) => (
        <video
          src={url}
          className="block max-h-64 w-full max-w-80 object-contain"
          autoPlay
          muted
          loop
          playsInline
          onError={onError}
        />
      )}
    />
  );
}

/** Reviewed text, with each media marker shown as its label plus a click-to-expand preview and a link. */
export function MarkerText({ text }: { text: string }) {
  const segments = splitMediaMarkers(text);
  return (
    <>
      {segments.map((segment, i) => (
        // The url is in the key so a marker replaced at the same position remounts: otherwise the
        // previous item's "불러오지 못했습니다" (and its armed clip) would be inherited by the next.
        <Fragment key={segment.kind === "text" ? `text:${i}` : `${segment.kind}-${i}-${segment.url}`}>
          {/* The split is line-aligned, so the newline between two segments belongs back here. */}
          {i > 0 && "\n"}
          {segment.kind === "photo" ? (
            <PhotoMarker text={segment.text} url={segment.url} />
          ) : segment.kind === "video" ? (
            <VideoMarker url={segment.url} />
          ) : (
            segment.text
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Why this box has no preview. This used to say a `<textarea>` cannot host a *hover* target on a
 * substring — true when this idiom was hover-only, but Task 5 made the preview a click target
 * (tap the label to expand it in place), and a `<textarea>` cannot host a click target on a
 * substring either: there is no element inside it to attach a handler to, only characters. So the
 * preview still lives in the read-only pane and this line still says where — but only when the
 * text actually carries media, so a copy without it looks exactly as it did before.
 */
export function MediaEditNotice({ text, where }: { text: string; where: string }) {
  const { photos, videos, videosWithUrl } = countMediaMarkers(text);
  if (photos + videos === 0) return null;
  // Which sentence is true depends on the text in front of THIS reviewer, not on the feature: a
  // `[영상]` saved before the url was captured still has nothing to show. Where a copy carries both
  // kinds of video marker, the second half is scoped to `일부` — "영상 미리보기는 …에서 확인하세요 ·
  // 영상은 미리보기가 없습니다" would read as the notice contradicting itself.
  const previewable = [...(photos > 0 ? ["이미지"] : []), ...(videosWithUrl > 0 ? ["영상"] : [])];
  const parts: string[] = [];
  if (previewable.length > 0) parts.push(`${previewable.join("와 ")} 미리보기는 ${where}에서 확인하세요`);
  if (videos > videosWithUrl) {
    parts.push(`${videosWithUrl > 0 ? "일부 " : ""}영상은 미리보기가 없습니다`);
  }
  return <p className="text-[12px] leading-relaxed text-faint">{parts.join(" · ")}</p>;
}

/**
 * The slot every editing textarea on the board puts `MediaEditNotice` in — extracted so this idiom
 * (and its reasoning) exists once instead of being hand-copied at every call site.
 *
 * Reserves one line at the notice's own type scale so whatever sits below never moves as a marker
 * starts or stops matching mid-edit: an `aria-hidden` placeholder line and the real notice share one
 * grid cell (the same same-cell-overlap trick the 승인됨/승인 취소 button labels elsewhere on the
 * board use), so the slot is exactly one line tall whether or not `MediaEditNotice` has anything to
 * render. `MediaEditNotice` itself still returns null on clean text — the strut lives here, not
 * there, precisely so that contract stays untouched.
 *
 * The placeholder's content MUST be a non-breaking space (` `), not an ordinary one: an ordinary
 * space is whitespace under `white-space: normal`, collapses to nothing, and a `<p>` with no content
 * generates no line box — the slot silently goes back to 0px and the strut stops strutting.
 */
export function MediaEditNoticeSlot({
  text,
  where,
  className = "",
}: {
  text: string;
  where: string;
  className?: string;
}) {
  return (
    <div className={`grid ${className}`.trim()} data-testid="media-edit-notice-slot">
      <p aria-hidden="true" className="invisible col-start-1 row-start-1 text-[12px] leading-relaxed">
        {" "}
      </p>
      <div className="col-start-1 row-start-1">
        <MediaEditNotice text={text} where={where} />
      </div>
    </div>
  );
}
