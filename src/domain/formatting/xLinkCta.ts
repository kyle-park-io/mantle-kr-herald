import type { Channel } from "./models";
import type { DeliveryEntry } from "../delivery/models";
import { deliveredToRoom } from "../delivery/models";

/**
 * The 공지 CTA, composed at send time rather than stored on the rendering.
 *
 * It cannot be stored: a rendering is written by `FormatVariants` before the X post it points at
 * exists (`ConvertTick.ts:16-20` stops at `rendered`), and re-rendering after publication is
 * refused outright (`FormatVariants.ts:120-121`). So the URL is late-bound by definition.
 *
 * Both the bot path (`SendChannels`) and the [복사] preview (`/emissions`) call these. That is not
 * an accident of two call sites: every KakaoTalk room and two of the Telegram rooms are
 * `delivery: "manual"` (`src/domain/outlet/models.ts:42-46`), so a human pastes what the board
 * shows. If the two paths composed the CTA separately they would eventually disagree, and the copy
 * a room receives would depend on who sent it.
 */

/** Per-channel CTA icon. A channel absent from this map gets no CTA at all. */
const CTA_ICON: Partial<Record<Channel, string>> = {
  telegram: "➡",
  kakao: "👉",
};

const CTA_LABEL = "자세한 내용은 X에서 확인하세요";

/** Only the KR account's own post counts. See `resolveXPostUrl`. */
const X_POST_PREFIX = "https://x.com/";

/** The room the KR X post is delivered to (`src/domain/outlet/models.ts:36`). */
const X_POST_OUTLET = "x-post";

/**
 * Stand-in shown in the [복사] preview before the X post exists. Deliberately not a URL: a preview
 * is copy-pasteable, and a plausible-looking placeholder would eventually reach a live room.
 */
export const X_URL_PENDING = "X 게시 후 채워짐";

/** 공지 only, and only on the two channels that carry it. */
export function needsXLinkCta(type: string, channel: Channel): boolean {
  return type === "announcement" && CTA_ICON[channel] !== undefined;
}

/**
 * Never a markdown link. `emitTelegramBot` rewrites `[label](url)` into `<a href>`
 * (`emitters/telegram.ts:44-46`), which would hide the URL — and the URL showing is the point.
 * `label (url)` carries no `[`, so `MD_LINK` cannot match it and every emitter passes it through.
 */
export function xLinkCta(channel: Channel, xUrl: string): string {
  return `${CTA_ICON[channel]} ${CTA_LABEL} (${xUrl})`;
}

/** One blank line, i.e. a canonical paragraph break — never three, which is an x post boundary. */
export function appendXLinkCta(text: string, cta: string): string {
  return `${text}\n\n${cta}`;
}

function isXPostUrl(url: string | undefined): url is string {
  return url !== undefined && url.startsWith(X_POST_PREFIX);
}

/**
 * The KR X post URL for one item, or undefined if it has not gone up yet.
 *
 * Two sources, because there are two ways the post gets made. A hand-posted one is reconciled onto
 * the translation (`RetireTranslation.ts:136`, via `pnpm x:reconcile` or `pnpm x:link`); a bot-sent
 * one lands on the `x-post` delivery row (`ReconcilePublished.ts:71-73`).
 *
 * The `https://x.com/` check is not decoration. `SendChannels` writes the Typefully *share* url onto
 * that delivery row at send time (`SendChannels.ts:301`) and it only becomes an x.com url minutes
 * later, when the draft actually publishes. Without this check a 공지 would carry a link to our own
 * draft editor.
 */
export function resolveXPostUrl(
  translation: { postedUrl?: string } | undefined,
  deliveries: DeliveryEntry[],
): string | undefined {
  // Bound to a local first: a type guard on `translation?.postedUrl` narrows that expression, not
  // `translation`, so reading it back off the object would still be `possibly undefined` to tsc.
  const posted = translation?.postedUrl;
  if (isXPostUrl(posted)) return posted;
  const row = deliveries.find((d) => d.outletId === X_POST_OUTLET && deliveredToRoom(d) && isXPostUrl(d.url));
  return row?.url;
}
