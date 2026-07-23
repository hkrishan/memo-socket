import type { Server } from 'socket.io';
import { env } from '../config/env.js';
import { cache } from '../store/cache.js';
import { albumRoom } from '../types/chat.js';
import { Log } from '../utils/logger.js';

const PREVIEW_MAX_LENGTH = 80;
const THROTTLE_WINDOW_SECONDS = 30;

// In-memory fallback throttle for when Valkey is unavailable.
const localThrottle = new Map<string, number>();
const LOCAL_THROTTLE_MAX_ENTRIES = 5000;

const throttleKey = (albumId: string, senderId: string): string =>
  `chat:pushrelay:${albumId}:${senderId}`;

/** True when a relay already fired for this (album, sender) inside the window. */
const isThrottled = async (albumId: string, senderId: string): Promise<boolean> => {
  const key = throttleKey(albumId, senderId);
  const client = cache();

  if (client) {
    try {
      // SET NX EX — only the first caller inside the window gets through
      const result = await client.set(key, '1', 'EX', THROTTLE_WINDOW_SECONDS, 'NX');
      return result === null;
    } catch {
      // Valkey trouble — fall back to the local window below
    }
  }

  const now = Date.now();
  const last = localThrottle.get(key);
  if (last !== undefined && now - last < THROTTLE_WINDOW_SECONDS * 1000) {
    return true;
  }
  if (localThrottle.size >= LOCAL_THROTTLE_MAX_ENTRIES) localThrottle.clear();
  localThrottle.set(key, now);
  return false;
};

/**
 * Fire-and-forget push relay: tells memo-api that a chat message landed so it
 * can push to album members who are not actively in the chat room. Never
 * throws — chat delivery must not depend on push delivery.
 */
export const relayChatPush = async (
  io: Server,
  input: {
    albumId: string;
    senderId: string;
    senderName: string;
    content: string;
  },
): Promise<void> => {
  try {
    if (await isThrottled(input.albumId, input.senderId)) return;

    // Users with a socket currently in the room are reading the chat live —
    // memo-api skips pushing to them.
    const sockets = await io.in(albumRoom(input.albumId)).fetchSockets();
    const activeUserIds = [
      ...new Set(
        sockets
          .map((s) => (s.data as { userId?: string }).userId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];

    const url = `${env.API_URL}/internal/albums/${encodeURIComponent(input.albumId)}/chat-push`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': env.INTERNAL_SECRET,
      },
      body: JSON.stringify({
        senderId: input.senderId,
        senderName: input.senderName,
        preview: input.content.slice(0, PREVIEW_MAX_LENGTH),
        activeUserIds,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      Log.error('Chat push relay rejected', {
        tags: ['push', 'relay', 'error'],
        meta: { albumId: input.albumId, status: response.status },
      });
    }
  } catch (error) {
    Log.error('Chat push relay failed', {
      tags: ['push', 'relay', 'error'],
      meta: {
        albumId: input.albumId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
};
