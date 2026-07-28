import { describe, it, expect } from "vitest";
import { publishRowLinks, type PublishLinkConfig } from "../../../src/adapters/web/publishLinks";

const cfg: PublishLinkConfig = {
  google: { reviewFolderId: "GR", approvedFolderId: "GA" },
  lark: { workspaceUrl: "https://t.larksuite.com", reviewFolderToken: "LR", approvedFolderToken: "LA" },
};

describe("publishRowLinks", () => {
  it("google translated → review folder + webViewLink file", () => {
    expect(publishRowLinks({ target: "google", status: "translated", url: "https://drive/f1" }, cfg))
      .toEqual({ folderUrl: "https://drive.google.com/drive/folders/GR", fileUrl: "https://drive/f1" });
  });
  it("google approved → approved folder", () => {
    expect(publishRowLinks({ target: "google", status: "approved", url: "u" }, cfg).folderUrl)
      .toBe("https://drive.google.com/drive/folders/GA");
  });
  it("lark translated → workspace review folder + file url from remoteId", () => {
    expect(publishRowLinks({ target: "lark", status: "translated", remoteId: "TK" }, cfg))
      .toEqual({ folderUrl: "https://t.larksuite.com/drive/folder/LR", fileUrl: "https://t.larksuite.com/file/TK" });
  });
  it("lark approved → approved folder token", () => {
    expect(publishRowLinks({ target: "lark", status: "approved", remoteId: "TK" }, cfg).folderUrl)
      .toBe("https://t.larksuite.com/drive/folder/LA");
  });
  it("lark without remoteId → no fileUrl", () => {
    expect(publishRowLinks({ target: "lark", status: "translated" }, cfg).fileUrl).toBeUndefined();
  });
  it("local → both undefined (frontend builds the local file link)", () => {
    expect(publishRowLinks({ target: "local", status: "translated", remoteId: "approved/x.md" }, cfg)).toEqual({});
  });
  it("no google config → no folderUrl but keeps the file webViewLink", () => {
    expect(publishRowLinks({ target: "google", status: "translated", url: "u" }, {}))
      .toEqual({ folderUrl: undefined, fileUrl: "u" });
  });
  it("no lark config → empty", () => {
    expect(publishRowLinks({ target: "lark", status: "translated", remoteId: "TK" }, {})).toEqual({});
  });
});
