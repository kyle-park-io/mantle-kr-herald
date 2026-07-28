// tests/domain/outlet/models.test.ts
import { describe, expect, it } from "vitest";
import { ALL_OUTLETS, PRIMARY_OUTLET_BY_CHANNEL, deliveredByChannelSender, outletById, outletsForChannel } from "../../../src/domain/outlet/models";
import { ALL_CHANNELS } from "../../../src/domain/formatting/models";
import { ALL_TYPES } from "../../../src/domain/conversion/models";

describe("outlet model", () => {
  it("defines the nine rooms with unique ids", () => {
    expect(ALL_OUTLETS).toHaveLength(9);
    expect(new Set(ALL_OUTLETS.map((o) => o.id)).size).toBe(9);
  });

  it("looks an outlet up by id and returns undefined for an unknown one", () => {
    expect(outletById("tg-dev")?.label).toBe("맨틀 한국 데브방");
    expect(outletById("nope")).toBeUndefined();
  });

  it("groups outlets by channel — telegram carries four rooms", () => {
    expect(outletsForChannel("telegram").map((o) => o.id)).toEqual(["tg-community", "tg-dev", "tg-kol", "tg-blockchain"]);
    expect(outletsForChannel("kakao").map((o) => o.id)).toEqual(["kakao-kol", "kakao-blockchain"]);
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

  it("gives the article outlet no suggested types — the translation goes direct", () => {
    expect(outletById("x-article")?.suggestedTypes).toEqual([]);
  });

  it("leaves the article outlet to its own pipeline — send:channels must not also post it", () => {
    // Both x rooms are `auto`, so `delivery` alone cannot tell them apart: x-article is posted by
    // `send:x-article` from the translation, and delivering it from send:channels too would put the
    // same copy on the account twice.
    expect(deliveredByChannelSender(outletById("x-post")!)).toBe(true);
    expect(deliveredByChannelSender(outletById("x-article")!)).toBe(false);
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
