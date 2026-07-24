import { createServer } from 'http';
import express from 'express';
import { env } from './config/env.js';
import { createSocketServer } from './server/socketServer.js';
import { createHttpServer } from './server/httpServer.js';
import { createInternalRoutes } from './server/internalRoutes.js';
import { Log } from './utils/logger.js';
import { serverInfo } from './state/instance.js';

serverInfo.name = `memo-socket-instance-${Math.random().toString(36).substring(2, 8)}`;

const start = async () => {
  // Base HTTP server that Socket.IO and Express share
  const baseApp = express();
  const httpServer = createServer(baseApp);

  // Socket.IO server (attaches Valkey adapter when available)
  const { io, shutdown: shutdownSockets } = await createSocketServer(httpServer);

  // Plain HTTP routes (health) + internal server-to-server routes
  baseApp.use(express.json());
  baseApp.use(createHttpServer());
  baseApp.use(createInternalRoutes(io));

  httpServer.listen(Number(env.PORT), () => {
    Log.info('memo-socket started', {
      tags: ['socket', 'server', 'startup'],
      meta: {
        port: env.PORT,
        environment: env.NODE_ENV,
        instance: serverInfo.name,
      },
    });
  });

  // Graceful shutdown: disconnect sockets, close Valkey clients, then exit.
  // Clients auto-reconnect to a healthy instance; unsent messages are the
  // client's to retry (acks make loss visible).
  const SHUTDOWN_TIMEOUT_MS = 10_000;
  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    Log.info('Shutting down', {
      tags: ['socket', 'server', 'shutdown'],
      meta: { signal, instance: serverInfo.name },
    });

    const forceExit = setTimeout(() => {
      Log.error('Shutdown timed out — forcing exit', {
        tags: ['socket', 'server', 'shutdown'],
      });
      process.exit(exitCode || 1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void shutdownSockets()
      .catch((error) => {
        Log.error('Shutdown error', {
          tags: ['socket', 'server', 'shutdown'],
          meta: { error: error instanceof Error ? error.message : String(error) },
        });
      })
      .finally(() => process.exit(exitCode));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    Log.error('Uncaught exception', {
      tags: ['socket', 'process', 'critical'],
      meta: { error: error.message, stack: error.stack },
    });
    shutdown('uncaughtException', 1);
  });
};

start().catch((error) => {
  Log.error('Failed to start server', {
    tags: ['socket', 'server', 'critical'],
    meta: { error: error instanceof Error ? error.message : String(error) },
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  Log.error('Unhandled rejection', {
    tags: ['socket', 'process', 'error'],
    meta: { reason: reason instanceof Error ? reason.message : String(reason) },
  });
});
