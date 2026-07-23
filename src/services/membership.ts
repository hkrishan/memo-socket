import { env } from '../config/env.js';
import { cache } from '../store/cache.js';
import { Log } from '../utils/logger.js';

export type AlbumMemberProfile = {
  userId: string;
  name: string;
  avatarUrl: string | null;
};

const POSITIVE_TTL_SECONDS = 120;
const NEGATIVE_TTL_SECONDS = 15;
const NEGATIVE_SENTINEL = 'null';

const memberCacheKey = (albumId: string, userId: string): string =>
  `chat:member:${albumId}:${userId}`;

const readCache = async (key: string): Promise<AlbumMemberProfile | null | undefined> => {
  const client = cache();
  if (!client) return undefined;
  try {
    const raw = await client.get(key);
    if (raw === null) return undefined; // miss
    if (raw === NEGATIVE_SENTINEL) return null; // cached "not a member"
    return JSON.parse(raw) as AlbumMemberProfile;
  } catch {
    return undefined; // cache trouble — fall through to memo-api
  }
};

const writeCache = async (key: string, member: AlbumMemberProfile | null): Promise<void> => {
  const client = cache();
  if (!client) return;
  try {
    if (member) {
      await client.set(key, JSON.stringify(member), 'EX', POSITIVE_TTL_SECONDS);
    } else {
      await client.set(key, NEGATIVE_SENTINEL, 'EX', NEGATIVE_TTL_SECONDS);
    }
  } catch {
    // Best-effort cache — ignore write failures
  }
};

/**
 * Resolves a user's membership (and display profile) in an album via
 * memo-api's internal endpoint, with a short Valkey cache in front.
 * Returns null when the user is not a member. Throws on lookup failure so
 * callers can ack an error instead of silently denying access.
 */
export const getAlbumMember = async (
  albumId: string,
  userId: string,
): Promise<AlbumMemberProfile | null> => {
  const key = memberCacheKey(albumId, userId);

  const cached = await readCache(key);
  if (cached !== undefined) return cached;

  const url = `${env.API_URL}/internal/albums/${encodeURIComponent(albumId)}/members/${encodeURIComponent(userId)}`;
  const response = await fetch(url, {
    headers: { 'x-internal-secret': env.INTERNAL_SECRET },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    Log.error('Membership lookup failed', {
      tags: ['membership', 'api', 'error'],
      meta: { albumId, userId, status: response.status },
    });
    throw new Error(`Membership lookup failed (${response.status})`);
  }

  const body = (await response.json()) as { member: AlbumMemberProfile | null };
  const member = body.member ?? null;

  await writeCache(key, member);

  return member;
};
