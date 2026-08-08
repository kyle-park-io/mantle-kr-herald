import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dashboard's HTML shell, asserted directly rather than through a rendered component: nothing
 * in `web/src` can see `<head>`, so a change here is invisible to every other test in this suite.
 */
const indexHtml = await readFile(join(process.cwd(), "web", "index.html"), "utf8");

describe("web/index.html", () => {
  /**
   * Deleting this meta breaks the video preview and NOTHING ELSE — no test turns red, no console
   * error on the page anyone reads, no visible change until a reviewer hovers a clip and is told
   * "영상을 불러오지 못했습니다" for every video forever. That is exactly the failure this repo
   * cannot detect on its own, so it is pinned here.
   *
   * Why it is needed: `video.twimg.com` enforces a Referer allowlist. The same mp4 returns 200 with
   * no Referer and 403 with this dashboard's origin (verified against three stored clips), and a
   * `<video>` that gets a 403 fails with MEDIA_ERR_SRC_NOT_SUPPORTED. `pbs.twimg.com` does not
   * enforce it, which is why photo previews were never affected and why nobody would connect the
   * two.
   *
   * Why it cannot be scoped to the element: `referrerpolicy` is defined for img/iframe/link/script/a
   * but not for media elements — `"referrerPolicy" in document.createElement("video")` is false in
   * Chromium, and setting the attribute anyway leaves the request unchanged.
   */
  it("sends no referrer, without which video.twimg.com 403s every clip preview", () => {
    expect(indexHtml).toMatch(/<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/);
  });
});
