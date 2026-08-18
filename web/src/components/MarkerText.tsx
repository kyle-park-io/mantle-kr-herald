import { Fragment, useState, type ReactNode } from "react";
import { countMediaMarkers, splitMediaMarkers } from "../media";

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
 * Unlike the board's other hover cards (now `InfoPopover`), this one stays an inline accordion. A
 * 320px popover on a phone covers almost all of the source text it sits in, and the preview's whole
 * job is letting a reviewer compare that text against the photo — cover it and the preview has no job
 * left. So it expands downward in place instead.
 *
 * The spec that proposed this had the preview itself branch popover-vs-inline on the source pane's
 * width, via a `@container` on the caller. The implementation below does not — it renders
 * unconditionally inline, at a fixed `w-full max-w-80` (see `PhotoMarker`/`VideoMarker`'s `preview`),
 * with no `@`-variant class anywhere in this file. That is the better call (a preview that changes
 * shape under the reviewer mid-scroll is its own kind of confusing), but it means the `@container`s
 * `TranslationDetail`'s 원문 pane and `OutletCard`'s `Source` used to carry for this component's sake
 * query nothing — nothing inside either one has an `@`-variant class. Both were removed; if this
 * component ever does need to know its container's width again, the container has to come back too.
 *
 * Mount is deferred behind `armed` rather than left to `preload="none"`: `autoPlay` overrides that
 * hint the moment a `<video>` exists, and a merely-hidden (`display: none`) element still fetches. A
 * 2차 card can show a dozen markers at once, so mounting eagerly would pull every photo and clip down
 * before anyone opened one. `onMouseEnter` used to be the arm signal; the first open now does that
 * job instead. Once armed, the preview element stays mounted — collapsing only hides it — so a
 * second look is instant and a buffered clip is not thrown away.
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

  return (
    <span className="inline">
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
      {armed && (
        <span
          data-testid="media-preview"
          className={`${open ? "block" : "hidden"} mt-1.5 rounded-lg border border-line bg-surface p-1.5`}
        >
          {failed ? (
            <span className="block px-1 py-0.5 text-[12px] leading-relaxed text-muted">{broken}</span>
          ) : (
            preview(() => setFailed(true))
          )}
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
