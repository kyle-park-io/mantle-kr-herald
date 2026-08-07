import { Fragment, useState } from "react";
import { countMediaMarkers, splitMediaMarkers } from "../media";

/**
 * A photo marker, shown as its label with the image one hover away and the original one click away.
 *
 * The raw url is no longer printed. It used to be, on the reasoning that "it is what the reviewer
 * reads today, and the send path uploads that exact string" — but a 60-character CDN url is not
 * something a reviewer reads, and in a thread carrying four photos it was most of the 원문. The url
 * is still there in the stored text, unchanged and still what gets uploaded; this is the read-only
 * pane, and the editable textarea beside it shows the line verbatim.
 *
 * `원본 보기` rather than making the label itself a link: the label is the hover target for the
 * preview, and one element cannot usefully be both "hover to peek" and "click to leave".
 */
function PhotoMarker({ text, url }: { text: string; url: string }) {
  const [failed, setFailed] = useState(false);
  const label = text.startsWith("[사진]") ? "[사진]" : "[이미지]";
  return (
    <span className="group/media relative cursor-help text-mint">
      {label}
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
      {/* Outside the hover target above, so moving the pointer here to click does not dismiss the
          preview the reviewer is comparing against. */}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="ml-1.5 cursor-pointer text-[12px] font-medium text-muted underline-offset-2 hover:text-mint hover:underline"
      >
        원본 보기 ↗
      </a>
    </span>
  );
}

/** Reviewed text, with each photo marker shown as its label plus a hover preview and a link. */
export function MarkerText({ text }: { text: string }) {
  const segments = splitMediaMarkers(text);
  return (
    <>
      {segments.map((segment, i) => (
        <Fragment key={segment.kind === "photo" ? `photo-${i}-${segment.url}` : `text:${i}`}>
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
