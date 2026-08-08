// tests/domain/outlet/models.test.ts
import { describe, expect, it } from "vitest";
import { ALL_OUTLETS, PRIMARY_OUTLET_BY_CHANNEL, deliveredByChannelSender, outletById, outletsForChannel } from "../../../src/domain/outlet/models";
import { X_ARTICLE_TARGET, isXArticleTarget } from "../../../src/domain/publish/xArticleTarget";
import { ALL_CHANNELS } from "../../../src/domain/formatting/models";
import { ALL_TYPES } from "../../../src/domain/conversion/models";

describe("outlet model", () => {
  it("defines the eight rooms with unique ids", () => {
    expect(ALL_OUTLETS).toHaveLength(8);
    expect(new Set(ALL_OUTLETS.map((o) => o.id)).size).toBe(8);
  });

  it("looks an outlet up by id and returns undefined for an unknown one", () => {
    expect(outletById("tg-dev")?.label).toBe("맨틀 한국 데브방");
    expect(outletById("nope")).toBeUndefined();
  });

  it("groups outlets by channel — telegram carries four rooms, x carries one", () => {
    expect(outletsForChannel("telegram").map((o) => o.id)).toEqual(["tg-community", "tg-dev", "tg-blockchain", "tg-kol"]);
    expect(outletsForChannel("kakao").map((o) => o.id)).toEqual(["kakao-blockchain", "kakao-kol"]);
    // One, not two. The X account's other surface is Articles, which is not a room — see below.
    expect(outletsForChannel("x").map((o) => o.id)).toEqual(["x-post"]);
  });

  it("names a primary outlet for every channel, and each one exists", () => {
    for (const channel of ALL_CHANNELS) {
      const id = PRIMARY_OUTLET_BY_CHANNEL[channel];
      expect(id, `primary outlet for ${channel}`).toBeTruthy();
      expect(outletById(id)?.channel, `primary of ${channel} must sit on ${channel}`).toBe(channel);
    }
  });

  it("only suggests types that exist, and only auto telegram rooms carry a chat id env", () => {
    for (const o of ALL_OUTLETS) {
      for (const t of o.suggestedTypes) expect(ALL_TYPES, `${o.id} suggests ${t}`).toContain(t);
      if (o.chatIdEnv) {
        expect(o.delivery, `${o.id} has a chat id but is not auto`).toBe("auto");
        expect(o.channel, `${o.id} has a chat id but is not telegram`).toBe("telegram");
      }
    }
  });

  it("keeps the X Articles surface out of the room registry entirely", () => {
    // It was registered here until 2026-08-08, which made it a room by every query the codebase can
    // ask — and left `outletsForChannel("x")` answering with something no room-shaped code path
    // could send to, tick, or finish. Its id still resolves through its own module, which is what
    // the CLIs match on to say where an article actually goes.
    expect(outletById(X_ARTICLE_TARGET.id)).toBeUndefined();
    expect(ALL_OUTLETS.map((o) => o.id)).not.toContain(X_ARTICLE_TARGET.id);
    expect(isXArticleTarget("x-article")).toBe(true);
    expect(isXArticleTarget("x-post")).toBe(false);
  });

  it("delivers every auto room through its channel's sender", () => {
    // With the article surface gone there is no auto room that `send:channels` must skip: `auto`
    // now means exactly "a bot posts it from a rendering". A future room that is auto but shipped by
    // some other pipeline would have to reopen this — and this list is what would fail first.
    expect(deliveredByChannelSender(outletById("x-post")!)).toBe(true);
    expect(ALL_OUTLETS.filter(deliveredByChannelSender).map((o) => o.id)).toEqual(["x-post", "tg-community", "tg-dev"]);
  });

  it("claims a channel sender only for rooms a channel sender can actually reach", () => {
    // `pr-mail` was `auto` with no mail sender anywhere in the repo: send:channels could not reach
    // it (pr_mail is not a SendableChannel) and MarkDelivery refused to tick it *because* it was
    // auto, so the room could never be delivered and never be marked. Every room this predicate
    // claims must sit on a channel send:channels actually sends.
    const sendable = ["x", "telegram"];
    for (const o of ALL_OUTLETS.filter(deliveredByChannelSender)) {
      expect(sendable, `${o.id} is claimed as bot-delivered but ${o.channel} has no sender`).toContain(o.channel);
    }
  });
});
