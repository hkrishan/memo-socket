import type { ValkeyClient } from '../lib/valkey.js';

/**
 * Shared Valkey cache client. Optional by design: when Valkey is unreachable
 * the server keeps running — membership lookups fall through to memo-api and
 * push-relay throttling falls back to an in-memory window.
 */
let _cache: ValkeyClient | null = null;

export const initCache = (client: ValkeyClient): void => {
  _cache = client;
};

export const cache = (): ValkeyClient | null => _cache;
