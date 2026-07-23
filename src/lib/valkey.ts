import { Redis, Cluster } from 'iovalkey';
import { env } from '../config/env.js';
import { Log } from '../utils/logger.js';

export type ValkeyClient = Redis | Cluster;

const VALKEY_ERROR_LOG_THROTTLE_MS = 30_000;
const VALKEY_SLOTS_CACHE_ERROR_THROTTLE_MS = 10 * 60_000;

const createThrottledErrorLogger = (
  message: string,
  tags: string[],
): ((error: Error) => void) => {
  let lastLogAt = 0;
  let suppressedCount = 0;
  let lastErrorMessage = '';

  return (error: Error) => {
    const now = Date.now();
    const currentErrorMessage = error.message || 'Unknown error';
    const isSlotsCacheError = currentErrorMessage.includes('Failed to refresh slots cache');
    const throttleWindow = isSlotsCacheError
      ? VALKEY_SLOTS_CACHE_ERROR_THROTTLE_MS
      : VALKEY_ERROR_LOG_THROTTLE_MS;
    const isSameError = currentErrorMessage === lastErrorMessage;
    const isWithinThrottleWindow = now - lastLogAt < throttleWindow;

    if (isSameError && isWithinThrottleWindow) {
      suppressedCount += 1;
      return;
    }

    Log.error(message, {
      tags,
      meta: {
        error: currentErrorMessage,
        ...(suppressedCount > 0 ? { suppressedCount } : {}),
      },
    });

    lastLogAt = now;
    lastErrorMessage = currentErrorMessage;
    suppressedCount = 0;
  };
};

const parseHostPort = (raw: string): { host: string; port: number } => {
  if (raw.includes('://')) {
    const parsed = new URL(raw);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: Number(parsed.port) || 6379,
    };
  }

  const [host, portStr] = raw.split(':');
  return { host: host || '127.0.0.1', port: Number(portStr) || 6379 };
};

const createClient = (): ValkeyClient => {
  const { host, port } = parseHostPort(env.CACHE_URL);
  const tlsEnabled = env.CACHE_TLS === 'true' || env.CACHE_URL.startsWith('rediss://');

  if (env.CACHE_CLUSTER_MODE === 'true') {
    return new Cluster([{ host, port }], {
      dnsLookup: (address: string, callback: (err: Error | null, resolvedAddress: string) => void) => {
        callback(null, address);
      },
      redisOptions: {
        maxRetriesPerRequest: null,
        ...(tlsEnabled ? { tls: {} } : {}),
      },
    });
  }

  return new Redis({
    host,
    port,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: true,
    ...(tlsEnabled ? { tls: {} } : {}),
  });
};

export const createValkeyPair = async (): Promise<{ pubClient: ValkeyClient; subClient: ValkeyClient }> => {
  const pubClient = createClient();
  const subClient = createClient();
  const logPubError = createThrottledErrorLogger('Valkey pub client error', ['valkey', 'error']);
  const logSubError = createThrottledErrorLogger('Valkey sub client error', ['valkey', 'error']);

  pubClient.on('error', (error) => {
    logPubError(error);
  });

  subClient.on('error', (error) => {
    logSubError(error);
  });

  if (pubClient instanceof Redis) await pubClient.connect();
  if (subClient instanceof Redis) await subClient.connect();

  Log.info('Valkey connected (pub/sub pair)', { tags: ['valkey', 'connection'] });

  return { pubClient, subClient };
};

export const createValkeyClient = async (): Promise<ValkeyClient> => {
  const client = createClient();
  const logError = createThrottledErrorLogger('Valkey cache client error', ['valkey', 'cache', 'error']);

  client.on('error', (error) => {
    logError(error);
  });

  if (client instanceof Redis) await client.connect();

  Log.info('Valkey cache client connected', { tags: ['valkey', 'cache'] });

  return client;
};
