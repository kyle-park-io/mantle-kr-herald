import { parseList } from "./args";
import { TelegramBotSender } from "../adapters/send/TelegramBotSender";
import { TypefullySender } from "../adapters/send/TypefullySender";
import { loadTelegramConfig, loadTypefullyConfig } from "../config";
import type { ChannelSender } from "../ports/ChannelSender";
import type { SendableChannel } from "../domain/send/channels";

export const ALL_CHANNEL_TARGETS = ["telegram", "x"] as const;
export const CHANNEL_TARGETS_USAGE = ALL_CHANNEL_TARGETS.join("|");

function isChannelTarget(v: string): v is SendableChannel {
  return (ALL_CHANNEL_TARGETS as readonly string[]).includes(v);
}

/** Expand `--target`. `both` = every channel; default = every channel. */
export function resolveChannelTargets(raw: string | undefined): SendableChannel[] {
  const requested = parseList(raw) ?? ["both"];
  const expanded = requested.flatMap((t) => (t === "both" ? [...ALL_CHANNEL_TARGETS] : [t]));
  const out: SendableChannel[] = [];
  for (const c of expanded) {
    if (!isChannelTarget(c)) throw new Error(`Unknown channel target: ${c} (expected ${CHANNEL_TARGETS_USAGE}, or "both")`);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Build only the requested senders, so a Typefully-less setup can still send Telegram. */
export function createSenders(targets: SendableChannel[]): Record<SendableChannel, ChannelSender | undefined> {
  const senders: Record<SendableChannel, ChannelSender | undefined> = { telegram: undefined, x: undefined };
  for (const t of targets) {
    if (t === "telegram") {
      const c = loadTelegramConfig();
      senders.telegram = new TelegramBotSender(c.botToken);
    } else {
      const c = loadTypefullyConfig();
      senders.x = new TypefullySender(c.apiKey, c.socialSetId);
    }
  }
  return senders;
}
