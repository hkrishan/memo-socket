import express from 'express';
import { serverInfo } from '../state/instance.js';
import { healthState } from '../state/health.js';
import { env } from '../config/env.js';

export const createHttpServer = () => {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.json({ ok: true, message: 'memo-socket running' });
  });

  // Liveness: process is up. Dependency state is reported but doesn't fail
  // this probe — that's /ready's job.
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      instance: serverInfo.name,
      adapter: healthState.adapterAttached,
      cache: healthState.cacheReady,
    });
  });

  // Readiness: in a multi-instance deployment (REQUIRE_ADAPTER=true) an
  // instance without the Valkey adapter must be pulled from rotation — it
  // silently misses cross-instance broadcasts.
  app.get('/ready', (_req, res) => {
    const adapterOk =
      env.REQUIRE_ADAPTER !== 'true' || healthState.adapterAttached;
    res.status(adapterOk ? 200 : 503).json({
      ok: adapterOk,
      instance: serverInfo.name,
      adapter: healthState.adapterAttached,
      cache: healthState.cacheReady,
    });
  });

  return app;
};
