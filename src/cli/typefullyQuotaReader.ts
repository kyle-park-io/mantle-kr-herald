import { TypefullyQuota, type PublishingQuota } from "../adapters/send/TypefullyQuota";
import { loadTypefullyConfig } from "../config";
import type { SendableChannel } from "../domain/send/channels";

/**
 * The quota reader `SendChannels` gates X sends with — or `undefined` when there is nothing to gate.
 *
 * Mirrors how `createSenders` only builds the senders it was asked for: a Telegram-only install has
 * no Typefully credentials and must not fail to start over a guard it does not need.
 */
export function quotaReader(targets: SendableChannel[]): (() => Promise<PublishingQuota>) | undefined {
  if (!targets.includes("x")) return undefined;
  let cfg;
  try {
    cfg = loadTypefullyConfig();
  } catch {
    // Unconfigured — `createSenders` will not build an X sender either, so there is no send to gate.
    return undefined;
  }
  const quota = new TypefullyQuota(cfg.apiKey, cfg.socialSetId);
  return () => quota.read();
}
