import { describe, it, expect } from "vitest";
import { DEFAULT_CHANNELS_BY_TYPE, ALL_CHANNELS } from "../../../src/domain/formatting/models";

describe("DEFAULT_CHANNELS_BY_TYPE", () => {
  it("maps each type to its default channels", () => {
    expect(DEFAULT_CHANNELS_BY_TYPE.x).toEqual(["x"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.announcement).toEqual(["telegram", "kakao"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.kol).toEqual(["telegram"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.pr).toEqual(["pr_mail"]);
    // telegram carries two types on purpose: an announcement and a KOL request are different copy
    expect(DEFAULT_CHANNELS_BY_TYPE.announcement).toContain("telegram");
    expect(DEFAULT_CHANNELS_BY_TYPE.kol).toContain("telegram");
    expect(ALL_CHANNELS).toEqual(["x", "telegram", "kakao", "pr_mail"]);
  });
});
