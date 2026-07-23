import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v7 as uuidv7 } from 'uuid';
import { dynamo } from '../lib/dynamo.js';
import { env } from '../config/env.js';
import type { ChatMessage } from '../types/chat.js';

export type NewMessageInput = {
  albumId: string;
  userId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  content: string;
  clientId?: string | undefined;
};

export type HistoryPage = {
  messages: ChatMessage[];
  hasMore: boolean;
};

type MessageItem = {
  albumId: string;
  messageId: string;
  userId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  content: string;
  createdAt: string;
  clientId: string | null;
};

const toChatMessage = (item: MessageItem): ChatMessage => ({
  messageId: item.messageId,
  albumId: item.albumId,
  userId: item.userId,
  authorName: item.authorName,
  authorAvatarUrl: item.authorAvatarUrl ?? null,
  content: item.content,
  createdAt: item.createdAt,
  ...(item.clientId ? { clientId: item.clientId } : {}),
});

/**
 * Persists a new message. messageId is a uuidv7, so the sort key orders
 * messages chronologically within an album partition.
 */
export const saveMessage = async (input: NewMessageInput): Promise<ChatMessage> => {
  const item: MessageItem = {
    albumId: input.albumId,
    messageId: uuidv7(),
    userId: input.userId,
    authorName: input.authorName,
    authorAvatarUrl: input.authorAvatarUrl,
    content: input.content,
    createdAt: new Date().toISOString(),
    clientId: input.clientId ?? null,
  };

  await dynamo.send(
    new PutCommand({
      TableName: env.DYNAMO_TABLE,
      Item: item,
    }),
  );

  return toChatMessage(item);
};

/**
 * Newest-first page of an album's messages. `before` is an exclusive cursor
 * (the oldest messageId of the previous page).
 */
export const getHistory = async (
  albumId: string,
  limit: number,
  before?: string,
): Promise<HistoryPage> => {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: env.DYNAMO_TABLE,
      KeyConditionExpression: 'albumId = :albumId',
      ExpressionAttributeValues: { ':albumId': albumId },
      ScanIndexForward: false,
      Limit: limit,
      ...(before ? { ExclusiveStartKey: { albumId, messageId: before } } : {}),
    }),
  );

  return {
    messages: (result.Items ?? []).map((item) => toChatMessage(item as MessageItem)),
    hasMore: Boolean(result.LastEvaluatedKey),
  };
};
