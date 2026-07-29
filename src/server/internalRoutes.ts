import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import { env } from '../config/env.js';
import { userRoom } from '../types/chat.js';
import { Log } from '../utils/logger.js';

// Mirrors memo-api's internal middleware: constant-time compare, reject
// everything when the secret is unset.
const requireInternalSecret = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void => {
  const provided = req.header('x-internal-secret') ?? '';
  const expected = env.INTERNAL_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'Internal endpoints disabled' });
    return;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

const notifySchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(500),
  notification: z.object({
    title: z.string().min(1),
    body: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
});

const dropFiredSchema = z.object({
  memberIds: z.array(z.string().min(1)).min(1).max(500),
  drop: z.object({
    albumId: z.string().min(1),
    albumTitle: z.string(),
    momentId: z.string().min(1),
    momentType: z.string().min(1),
    momentTitle: z.string(),
    eventId: z.string().min(1),
    firedAt: z.string().nullable(),
    deadlineAt: z.string().min(1),
  }),
});

/**
 * Server-to-server routes (memo-api → memo-socket). The cron worker calls
 * drop-fired when a moment event opens so connected clients react instantly
 * (takeover + Live Activity) instead of waiting for a poll or push.
 */
export const createInternalRoutes = (io: SocketIOServer) => {
  const router = express.Router();

  router.post('/internal/drop-fired', requireInternalSecret, (req, res) => {
    const result = dropFiredSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    const { memberIds, drop } = result.data;
    for (const memberId of memberIds) {
      io.to(userRoom(memberId)).emit('moment:drop', drop);
    }

    Log.info('Drop fired — broadcast to member rooms', {
      tags: ['moment', 'drop'],
      meta: {
        albumId: drop.albumId,
        eventId: drop.eventId,
        members: memberIds.length,
      },
    });
    res.json({ ok: true });
  });

  // Mirror of a push notification for foregrounded clients: memo-api calls
  // this alongside every push send; recipients with a live socket render an
  // in-app banner instead of the OS one.
  router.post('/internal/notify', requireInternalSecret, (req, res) => {
    const result = notifySchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    const { userIds, notification } = result.data;
    for (const userId of userIds) {
      io.to(userRoom(userId)).emit('notification:new', notification);
    }

    Log.info('Notification broadcast to user rooms', {
      tags: ['notification'],
      meta: { users: userIds.length },
    });
    res.json({ ok: true });
  });

  return router;
};
