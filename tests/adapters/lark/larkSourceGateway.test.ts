import { describe, it, expect } from "vitest";
import { LarkSourceGateway } from "../../../src/adapters/lark/LarkSourceGateway";

function rawMsg(id: string, msgType = "text", content = '{"text":"hi"}') {
  return {
    message_id: id,
    msg_type: msgType,
    create_time: "1750000000000",
    chat_id: "oc_x",
    body: { content },
  };
}

class FakeClient {
  public calls: { path: string; params?: Record<string, string> }[] = [];
  constructor(private readonly responder: (params?: Record<string, string>) => unknown) {}
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    this.calls.push({ path, params });
    return this.responder(params) as T;
  }
}

describe("LarkSourceGateway", () => {
  it("paginates via page_token and yields normalized text/post messages", async () => {
    const client = new FakeClient((params) =>
      params?.page_token
        ? { code: 0, data: { items: [rawMsg("om_2")], has_more: false, page_token: "" } }
        : { code: 0, data: { items: [rawMsg("om_1")], has_more: true, page_token: "pt1" } },
    );
    const gw = new LarkSourceGateway(client);

    const ids: string[] = [];
    for await (const m of gw.fetchMessages("oc_x")) ids.push(m.messageId);

    expect(ids).toEqual(["om_1", "om_2"]);
    expect(client.calls[0].path).toBe("/open-apis/im/v1/messages");
    expect(client.calls[0].params?.container_id).toBe("oc_x");
    expect(client.calls[0].params?.container_id_type).toBe("chat");
    expect(client.calls[0].params?.sort_type).toBe("ByCreateTimeAsc");
  });

  it("filters out non text/post message types", async () => {
    const client = new FakeClient(() => ({
      code: 0,
      data: { items: [rawMsg("om_1", "image", '{"image_key":"i"}'), rawMsg("om_2", "post", '{"content":[]}')], has_more: false },
    }));
    const gw = new LarkSourceGateway(client);

    const ids: string[] = [];
    for await (const m of gw.fetchMessages("oc_x")) ids.push(m.messageId);

    expect(ids).toEqual(["om_2"]);
  });

  it("skips malformed non-text/post items without throwing", async () => {
    const client = new FakeClient(() => ({
      code: 0,
      data: { items: [{ message_id: "om_img", msg_type: "image" }, rawMsg("om_ok")], has_more: false },
    }));
    const gw = new LarkSourceGateway(client);

    const ids: string[] = [];
    for await (const m of gw.fetchMessages("oc_x")) ids.push(m.messageId);

    expect(ids).toEqual(["om_ok"]);
  });

  it("passes start_time (unix seconds) when sinceTime is given", async () => {
    const client = new FakeClient(() => ({ code: 0, data: { items: [], has_more: false } }));
    const gw = new LarkSourceGateway(client);
    for await (const _ of gw.fetchMessages("oc_x", "2026-06-01T00:00:00.000Z")) { /* drain */ }
    const expected = String(Math.floor(Date.parse("2026-06-01T00:00:00.000Z") / 1000));
    expect(client.calls[0].params?.start_time).toBe(expected);
  });
});
