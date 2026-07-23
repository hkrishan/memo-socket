import type { Server, Socket } from 'socket.io';
import type { ZodType } from 'zod';
import {
  albumRoom,
  historySchema,
  joinSchema,
  leaveSchema,
  sendSchema,
  typingSchema,
  type Ack,
  type ChatMessage,
} from '../types/chat.js';
import { getAlbumMember, type AlbumMemberProfile } from '../services/membership.js';
import { getHistory, saveMessage } from '../services/messageStore.js';
import { relayChatPush } from '../services/pushRelay.js';
import { Log } from '../utils/logger.js';
import { createRateLimiter } from '../utils/rateLimiter.js';

const TYPING_EXPIRY_MS = 6000;

// Per-socket flood limits. Sends persist to Dynamo and broadcast to the whole
// room, so they get the tightest budget; typing is broadcast-only; queries
// (join/history) hit memo-api/Dynamo on cache misses.
const SEND_LIMIT = { limit: 15, windowMs: 10_000 };
const TYPING_LIMIT = { limit: 10, windowMs: 10_000 };
const QUERY_LIMIT = { limit: 30, windowMs: 10_000 };

type AckFn<T extends object> = (response: Ack<T>) => void;

const parsePayload = <T>(schema: ZodType<T>, payload: unknown): T | null => {
  const result = schema.safeParse(payload);
  return result.success ? result.data : null;
};

const safeAck = <T extends object>(ack: unknown): AckFn<T> => {
  return typeof ack === 'function' ? (ack as AckFn<T>) : () => undefined;
};

/** Membership gate used by every chat event. Returns null when denied. */
const requireMember = async (
  socket: Socket,
  albumId: string,
): Promise<AlbumMemberProfile | null> => {
  const userId = socket.data.userId as string;
  const member = await getAlbumMember(albumId, userId);
  if (!member) {
    Log.debug('Chat access denied — not an album member', {
      tags: ['chat', 'membership'],
      meta: { albumId, userId },
    });
  }
  return member;
};

export const registerChatHandler = (socket: Socket, io: Server): void => {
  const userId = socket.data.userId as string;

  // albumId -> auto-expire timer (+ display name) for this socket's typing indicator
  const typingTimers = new Map<string, { timer: NodeJS.Timeout; name: string }>();

  const sendLimiter = createRateLimiter(SEND_LIMIT.limit, SEND_LIMIT.windowMs);
  const typingLimiter = createRateLimiter(TYPING_LIMIT.limit, TYPING_LIMIT.windowMs);
  const queryLimiter = createRateLimiter(QUERY_LIMIT.limit, QUERY_LIMIT.windowMs);

  const emitTyping = (albumId: string, name: string, typing: boolean): void => {
    socket.to(albumRoom(albumId)).emit('chat:typing', {
      albumId,
      user: { userId, name },
      typing,
    });
  };

  /** Cancels a live typing indicator (if any) and broadcasts typing=false. */
  const clearTyping = (albumId: string): void => {
    const entry = typingTimers.get(albumId);
    if (!entry) return;
    clearTimeout(entry.timer);
    typingTimers.delete(albumId);
    emitTyping(albumId, entry.name, false);
  };

  socket.on('chat:join', async (payload: unknown, ack: unknown) => {
    const respond = safeAck<Record<never, never>>(ack);
    try {
      const data = parsePayload(joinSchema, payload);
      if (!data) return respond({ ok: false, error: 'Invalid payload' });

      if (!queryLimiter.consume()) {
        return respond({ ok: false, error: 'Too many requests — slow down' });
      }

      const member = await requireMember(socket, data.albumId);
      if (!member) return respond({ ok: false, error: 'Not a member of this album' });

      await socket.join(albumRoom(data.albumId));
      Log.debug('Socket joined album chat', {
        tags: ['chat', 'room'],
        meta: { albumId: data.albumId, userId, socketId: socket.id },
      });
      respond({ ok: true });
    } catch (error) {
      Log.error('chat:join failed', {
        tags: ['chat', 'error'],
        meta: { error: error instanceof Error ? error.message : String(error) },
      });
      respond({ ok: false, error: 'Failed to join chat' });
    }
  });

  socket.on('chat:leave', async (payload: unknown) => {
    try {
      const data = parsePayload(leaveSchema, payload);
      if (!data) return;

      // Stop any live typing indicator before leaving the room
      clearTyping(data.albumId);

      await socket.leave(albumRoom(data.albumId));
    } catch (error) {
      Log.error('chat:leave failed', {
        tags: ['chat', 'error'],
        meta: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  socket.on('chat:history', async (payload: unknown, ack: unknown) => {
    const respond = safeAck<{ messages: ChatMessage[]; hasMore: boolean }>(ack);
    try {
      const data = parsePayload(historySchema, payload);
      if (!data) return respond({ ok: false, error: 'Invalid payload' });

      if (!queryLimiter.consume()) {
        return respond({ ok: false, error: 'Too many requests — slow down' });
      }

      const member = await requireMember(socket, data.albumId);
      if (!member) return respond({ ok: false, error: 'Not a member of this album' });

      const page = await getHistory(data.albumId, data.limit, data.before);
      respond({ ok: true, messages: page.messages, hasMore: page.hasMore });
    } catch (error) {
      Log.error('chat:history failed', {
        tags: ['chat', 'history', 'error'],
        meta: { error: error instanceof Error ? error.message : String(error) },
      });
      respond({ ok: false, error: 'Failed to load messages' });
    }
  });

  socket.on('chat:send', async (payload: unknown, ack: unknown) => {
    const respond = safeAck<{ message: ChatMessage }>(ack);
    try {
      const data = parsePayload(sendSchema, payload);
      if (!data) return respond({ ok: false, error: 'Invalid payload' });

      if (!sendLimiter.consume()) {
        return respond({ ok: false, error: 'Sending too fast — slow down' });
      }

      const member = await requireMember(socket, data.albumId);
      if (!member) return respond({ ok: false, error: 'Not a member of this album' });

      const message = await saveMessage({
        albumId: data.albumId,
        userId,
        authorName: member.name,
        authorAvatarUrl: member.avatarUrl,
        content: data.content,
        clientId: data.clientId,
      });

      // Sending a message ends the typing indicator
      clearTyping(data.albumId);

      // Everyone in the room except this socket (the ack covers it) — that
      // includes the sender's other devices; clientId lets clients dedupe.
      socket.to(albumRoom(data.albumId)).emit('chat:message', message);

      respond({ ok: true, message });

      // Fire-and-forget: memo-api pushes to members not in the room
      void relayChatPush(io, {
        albumId: data.albumId,
        senderId: userId,
        senderName: member.name,
        content: message.content,
      });
    } catch (error) {
      Log.error('chat:send failed', {
        tags: ['chat', 'send', 'error'],
        meta: { error: error instanceof Error ? error.message : String(error) },
      });
      respond({ ok: false, error: 'Failed to send message' });
    }
  });

  socket.on('chat:typing', async (payload: unknown) => {
    try {
      const data = parsePayload(typingSchema, payload);
      if (!data) return;

      // Silently drop over-limit typing events — they're only cosmetic
      if (!typingLimiter.consume()) return;

      const member = await requireMember(socket, data.albumId);
      if (!member) return;

      const existing = typingTimers.get(data.albumId);
      if (existing) clearTimeout(existing.timer);

      if (data.typing) {
        // Auto-expire after silence so a dropped "typing: false" can't
        // leave a stuck indicator
        const timer = setTimeout(() => {
          typingTimers.delete(data.albumId);
          emitTyping(data.albumId, member.name, false);
        }, TYPING_EXPIRY_MS);
        timer.unref?.();
        typingTimers.set(data.albumId, { timer, name: member.name });
      } else {
        typingTimers.delete(data.albumId);
      }

      emitTyping(data.albumId, member.name, data.typing);
    } catch (error) {
      Log.error('chat:typing failed', {
        tags: ['chat', 'typing', 'error'],
        meta: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  socket.on('disconnect', () => {
    // Broadcast typing=false for any album this socket was still typing in,
    // then drop all timers
    for (const [albumId, entry] of typingTimers) {
      clearTimeout(entry.timer);
      emitTyping(albumId, entry.name, false);
    }
    typingTimers.clear();
  });
};
