import { z } from 'zod';

/** Wire shape of a chat message — FROZEN contract shared with the app. */
export type ChatMessage = {
  messageId: string;
  albumId: string;
  userId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  content: string;
  createdAt: string;
  clientId?: string;
};

export type Ack<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export const HISTORY_DEFAULT_LIMIT = 40;
export const HISTORY_MAX_LIMIT = 80;

export const joinSchema = z.object({
  albumId: z.string().min(1),
});

export const leaveSchema = z.object({
  albumId: z.string().min(1),
});

export const historySchema = z.object({
  albumId: z.string().min(1),
  before: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).default(HISTORY_DEFAULT_LIMIT),
});

export const sendSchema = z.object({
  albumId: z.string().min(1),
  content: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(2000)),
  clientId: z.string().min(1).max(120).optional(),
});

export const typingSchema = z.object({
  albumId: z.string().min(1),
  typing: z.boolean(),
});

export const albumRoom = (albumId: string): string => `album:${albumId}`;
export const userRoom = (userId: string): string => `user:${userId}`;
