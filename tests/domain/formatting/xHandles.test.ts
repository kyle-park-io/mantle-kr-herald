import { describe, it, expect } from "vitest";
import { linkXHandles } from "../../../src/domain/formatting/xHandles";

/**
 * On X, `@RWA_xyz` is already a link. On Telegram it is a **Telegram username** — it resolves to a
 * different service's account, or to nothing, and never to the X profile the copy is talking about.
 * Every Telegram-bound rendering in production on 2026-08-18 carried at least one
 * (`@SolanaConf`, `@RWA_xyz`, `@OpenstockInc`), so the reader had no way to reach any of them.
 *
 * The output is markdown rather than a finished anchor because the two Telegram destinations need
 * different shapes and the canonical helpers already know both: `linksToLabel` + the HTML pass give
 * the bot `<a href>`, and `linksToPlain` gives the paste path `@handle (url)`. Emitting markdown
 * here means this module never has to know which destination asked.
 */
describe("linkXHandles", () => {
  it("wraps a bare handle as a markdown link to the X profile", () => {
    expect(linkXHandles("맨틀은 @OpenstockInc를 통해 제공합니다."))
      .toBe("맨틀은 [@OpenstockInc](https://x.com/OpenstockInc)를 통해 제공합니다.");
  });

  it("links only the first mention of a handle, so a repeated tag does not repeat the url", () => {
    const out = linkXHandles("@RWA_xyz 기준입니다. @RWA_xyz가 집계했습니다.");
    expect(out).toBe("[@RWA_xyz](https://x.com/RWA_xyz) 기준입니다. @RWA_xyz가 집계했습니다.");
  });

  it("treats handles that differ only in case as the same account — X usernames are case-insensitive", () => {
    const out = linkXHandles("@RWA_xyz 그리고 @rwa_xyz");
    expect(out).toBe("[@RWA_xyz](https://x.com/RWA_xyz) 그리고 @rwa_xyz");
  });

  it("leaves a handle that is already a markdown link alone, label and url both", () => {
    const already = "[@RWA_xyz](https://x.com/RWA_xyz)에 따르면";
    expect(linkXHandles(already)).toBe(already);
  });

  it("does not touch a handle inside another link's label", () => {
    const already = "[@Mantle_Official 발표](https://x.com/Mantle_Official/status/1)";
    expect(linkXHandles(already)).toBe(already);
  });

  /**
   * "First mention" has to mean first *link*, not first bare one. A handle the author already linked
   * by hand has introduced the account; linking a later plain mention of it would put the same url
   * on screen twice, which is the exact repetition the first-only rule exists to stop.
   */
  it("counts a hand-written link as the mention that introduced the account", () => {
    const out = linkXHandles("[@RWA_xyz](https://x.com/RWA_xyz)에 따르면, @RWA_xyz가 집계했습니다.");
    expect(out).toBe("[@RWA_xyz](https://x.com/RWA_xyz)에 따르면, @RWA_xyz가 집계했습니다.");
  });

  it("does not touch an email address", () => {
    expect(linkXHandles("문의는 press@mantle.xyz 로 주세요.")).toBe("문의는 press@mantle.xyz 로 주세요.");
  });

  it("does not touch an @ inside a bare url", () => {
    const url = "https://example.com/@handle 를 보세요";
    expect(linkXHandles(url)).toBe(url);
  });

  /** X usernames cap at 15 characters, so a longer run is not a handle and must not be linked. */
  it("ignores a run longer than an X username can be", () => {
    const long = "@abcdefghijklmnopq";
    expect(linkXHandles(long)).toBe(long);
  });

  it("stops the handle at the first character X does not allow, so Korean particles stay outside", () => {
    expect(linkXHandles("@SolanaConf와 함께")).toBe("[@SolanaConf](https://x.com/SolanaConf)와 함께");
  });

  it("returns the text unchanged when there is no handle at all", () => {
    expect(linkXHandles("핸들이 없는 문장입니다.")).toBe("핸들이 없는 문장입니다.");
  });
});
