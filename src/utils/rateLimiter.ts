/**
 * Fixed-window event counter for per-socket flood protection. Cheap by
 * design — one limiter instance per socket per event class, no shared state.
 */
export type RateLimiter = { consume: () => boolean };

export const createRateLimiter = (limit: number, windowMs: number): RateLimiter => {
  let windowStart = 0;
  let count = 0;
  return {
    consume: (): boolean => {
      const now = Date.now();
      if (now - windowStart >= windowMs) {
        windowStart = now;
        count = 0;
      }
      count += 1;
      return count <= limit;
    },
  };
};
