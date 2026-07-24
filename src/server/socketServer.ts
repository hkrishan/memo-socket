import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { createAdapter, createShardedAdapter } from '@socket.io/redis-adapter';
import { Cluster } from 'iovalkey';
import { createValkeyPair, createValkeyClient } from '../lib/valkey.js';
import { initCache } from '../store/cache.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { userRoom } from '../types/chat.js';
import { registerChatHandler } from '../handlers/chatHandler.js';
import { Log } from '../utils/logger.js';
import { serverInfo } from '../state/instance.js';
import { healthState } from '../state/health.js';

export type SocketServerHandle = {
  io: SocketIOServer;
  /** Disconnects all sockets and closes Valkey clients. */
  shutdown: () => Promise<void>;
};

type Closable = { quit?: () => Promise<unknown>; disconnect?: () => void };

export const createSocketServer = async (httpServer: HttpServer): Promise<SocketServerHandle> => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  const closables: Closable[] = [];

  // Redis adapter for scaling across multiple instances — degrades to
  // single-instance operation when Valkey is unreachable. The degradation is
  // reflected in healthState so /ready can pull the instance out of rotation
  // in deployments that require cross-instance delivery.
  try {
    const { pubClient, subClient } = await createValkeyPair();
    closables.push(pubClient, subClient);
    const adapter = pubClient instanceof Cluster
      ? createShardedAdapter(pubClient, subClient)
      : createAdapter(pubClient, subClient);
    io.adapter(adapter);
    healthState.adapterAttached = true;
    Log.info('Socket.IO Redis adapter attached', { tags: ['socket', 'valkey'] });
  } catch (error) {
    Log.warn('Failed to attach Redis adapter — running single-instance only', {
      tags: ['socket', 'valkey', 'degraded'],
      meta: { error: error instanceof Error ? error.message : String(error) },
    });
  }

  // Cache client for membership caching + push-relay throttling. Optional:
  // without it, membership goes straight to memo-api and throttling falls
  // back to an in-memory window.
  try {
    const cacheClient = await createValkeyClient();
    closables.push(cacheClient);
    initCache(cacheClient);
    healthState.cacheReady = true;
    Log.info('Cache store initialized', { tags: ['socket', 'store'] });
  } catch (error) {
    Log.warn('Failed to initialize cache store — continuing without cache', {
      tags: ['socket', 'store', 'degraded'],
      meta: { error: error instanceof Error ? error.message : String(error) },
    });
  }

  // Handshake auth: every connection must present a valid memo-api access
  // token in `auth.token`
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) {
      return next(new Error('Authentication required'));
    }

    const result = verifyAccessToken(token);
    if (!result.ok) {
      Log.debug('Socket handshake rejected', {
        tags: ['socket', 'auth'],
        meta: { error: result.error },
      });
      return next(new Error('Invalid token'));
    }

    socket.data.userId = result.userId;
    next();
  });

  io.on('connection', (socket) => {
    Log.debug('New socket connection', {
      tags: ['socket', 'connection'],
      meta: { socketId: socket.id, userId: socket.data.userId, instance: serverInfo.name },
    });

    // Personal room so server-side events (drop fired, …) can target a user
    // across all their devices without knowing socket ids
    void socket.join(userRoom(socket.data.userId as string));

    registerChatHandler(socket, io);
  });

  const shutdown = async (): Promise<void> => {
    // io.close() stops accepting connections and disconnects live sockets
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
    for (const client of closables) {
      try {
        if (client.quit) await client.quit();
        else client.disconnect?.();
      } catch {
        // Best-effort — the process is exiting anyway
      }
    }
  };

  return { io, shutdown };
};
