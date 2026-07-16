import { z } from "zod";
import { extractText, type LarkMessage } from "../../domain/larkMessage";

const MessageRaw = z
  .object({
    message_id: z.string(),
    msg_type: z.string(),
    create_time: z.string(),
    chat_id: z.string(),
    thread_id: z.string().optional(),
    parent_id: z.string().optional(),
    sender: z.object({ id: z.string().optional() }).passthrough().optional(),
    body: z.object({ content: z.string() }).passthrough(),
  })
  .passthrough();

export const MessagesEnvelope = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      items: z.array(z.unknown()).nullish(),
      page_token: z.string().nullish(),
      has_more: z.boolean().nullish(),
    })
    .nullish(),
});

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/** Validate and convert a raw Lark message into a domain LarkMessage. */
export function normalizeMessage(raw: unknown): LarkMessage {
  const m = MessageRaw.parse(raw);
  const content = m.body.content;
  const createTimeMs = Number(m.create_time);
  const createdAt = Number.isFinite(createTimeMs)
    ? new Date(createTimeMs).toISOString()
    : new Date(0).toISOString();
  return {
    messageId: m.message_id,
    chatId: m.chat_id,
    msgType: m.msg_type,
    createdAt,
    senderId: m.sender?.id,
    threadId: emptyToUndefined(m.thread_id),
    parentId: emptyToUndefined(m.parent_id),
    text: extractText(m.msg_type, content),
    rawContent: content,
  };
}

/** Validate a messages-list envelope; throw on code !== 0. */
export function parseMessagesData(response: unknown): {
  items: unknown[];
  pageToken: string;
  hasMore: boolean;
} {
  const env = MessagesEnvelope.parse(response);
  if (env.code !== 0) {
    throw new Error(`Lark API error: code=${env.code} ${env.msg ?? ""}`.trim());
  }
  return {
    items: env.data?.items ?? [],
    pageToken: env.data?.page_token ?? "",
    hasMore: env.data?.has_more ?? false,
  };
}

const ChatRaw = z
  .object({
    chat_id: z.string(),
    name: z.string().nullish(),
  })
  .passthrough();

/** Validate a chats-list envelope; throw on code !== 0. */
export function parseChatsData(response: unknown): {
  items: { chatId: string; name: string }[];
  pageToken: string;
  hasMore: boolean;
} {
  const env = MessagesEnvelope.parse(response);
  if (env.code !== 0) {
    throw new Error(`Lark API error: code=${env.code} ${env.msg ?? ""}`.trim());
  }
  const items = (env.data?.items ?? []).map((raw) => {
    const c = ChatRaw.parse(raw);
    return { chatId: c.chat_id, name: c.name ?? "" };
  });
  return {
    items,
    pageToken: env.data?.page_token ?? "",
    hasMore: env.data?.has_more ?? false,
  };
}

const SendEnvelope = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({ message_id: z.string() }).nullish(),
});

/** Validate a message-send envelope; throw on code !== 0; return the created message_id. */
export function parseSendResult(response: unknown): string {
  const env = SendEnvelope.parse(response);
  if (env.code !== 0 || !env.data?.message_id) {
    throw new Error(`Lark API error: code=${env.code} ${env.msg ?? ""}`.trim());
  }
  return env.data.message_id;
}
