import express from 'express';
import { serverInfo } from '../state/instance.js';

export const createHttpServer = () => {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.json({ ok: true, message: 'memo-socket running' });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, instance: serverInfo.name });
  });

  return app;
};
