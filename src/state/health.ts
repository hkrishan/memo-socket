/**
 * Live dependency state for health/readiness reporting. Set once during
 * startup (and updated on failures) by socketServer; read by the HTTP
 * health routes so a degraded instance is visible to load balancers.
 */
export const healthState = {
  /** Valkey pub/sub adapter attached — required for multi-instance delivery */
  adapterAttached: false,
  /** Valkey cache store available (membership cache, push throttle) */
  cacheReady: false,
};
