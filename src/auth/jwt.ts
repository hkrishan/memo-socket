import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

type MemoJwtPayload = {
  sub?: string;
  type?: string;
  user?: {
    userId?: string;
    email?: string | null;
  };
  [key: string]: unknown;
};

export type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

/**
 * Verifies a memo-api access token (HS256, shared JWT_SECRET) and extracts
 * the user id with the same fallback logic memo-api's auth middleware uses:
 * `payload.user?.userId || payload.sub`.
 */
export const verifyAccessToken = (token: string): VerifyResult => {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
    }) as MemoJwtPayload;

    if (payload.type !== 'access') {
      return { ok: false, error: 'Invalid token type' };
    }

    const userId = payload.user?.userId || payload.sub;
    if (!userId || typeof userId !== 'string') {
      return { ok: false, error: 'Token has no user id' };
    }

    return { ok: true, userId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid token',
    };
  }
};
