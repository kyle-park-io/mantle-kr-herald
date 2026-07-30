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
