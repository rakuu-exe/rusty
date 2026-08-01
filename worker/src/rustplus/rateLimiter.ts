/**
 * Token bucket matching the Rust+ server's own rate limiter.
 *
 * Facepunch enforces two buckets: 50 tokens / +15 per second per IP, and
 * 25 tokens / +3 per second per playerId. The per-player bucket is the binding
 * one for a single-server bot, and exceeding it gets requests dropped rather
 * than queued, so we mirror it client-side and wait instead.
 *
 * Known request costs: most calls 1 token, getMap 5, sendTeamMessage 2.
 */

export const TOKEN_COSTS = {
  default: 1,
  getInfo: 1,
  getTime: 1,
  getMapMarkers: 1,
  getTeamInfo: 1,
  getEntityInfo: 1,
  getMap: 5,
  sendTeamMessage: 2,
} as const;

export type RequestKind = keyof typeof TOKEN_COSTS;

export function tokenCost(kind: string): number {
  return (TOKEN_COSTS as Record<string, number>)[kind] ?? TOKEN_COSTS.default;
}

export interface RateLimiterOptions {
  /** Bucket capacity. Defaults to the per-playerId limit of 25. */
  capacity?: number;
  /** Tokens replenished per second. Defaults to the per-playerId rate of 3. */
  refillPerSecond?: number;
  /**
   * Fraction of the bucket to keep in reserve, so a burst of scheduled polling
   * can never starve an interactive request (a user running `!heli` in game).
   */
  now?: () => number;
}

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  private tokens: number;
  private lastRefill: number;

  constructor(options: RateLimiterOptions = {}) {
    this.capacity = options.capacity ?? 25;
    this.refillPerSecond = options.refillPerSecond ?? 3;
    this.now = options.now ?? (() => Date.now());
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;

    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Current token count, primarily for tests and diagnostics. */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /** Milliseconds until `cost` tokens are available. 0 when ready now. */
  delayFor(cost: number): number {
    if (cost > this.capacity) {
      throw new Error(`Request costs ${cost} tokens but the bucket only holds ${this.capacity}`);
    }
    this.refill();
    if (this.tokens >= cost) return 0;
    return Math.ceil(((cost - this.tokens) / this.refillPerSecond) * 1000);
  }

  /** Consume tokens without waiting. Returns false if there were not enough. */
  tryConsume(cost: number): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Wait until `cost` tokens are available, then consume them. */
  async consume(cost: number): Promise<void> {
    // Loops because concurrent waiters can race for the same tokens; each
    // recomputes its own delay rather than assuming one wait is enough.
    for (;;) {
      const delay = this.delayFor(cost);
      if (delay === 0 && this.tryConsume(cost)) return;
      await new Promise((resolve) => setTimeout(resolve, Math.max(delay, 10)));
    }
  }
}

/**
 * Serialises requests through a rate limiter.
 *
 * Requests are executed one at a time in submission order. That is slower than
 * firing concurrently, but it keeps the bucket accounting honest and makes
 * ordering predictable when a poll and a chat reply land together.
 */
export class RateLimitedQueue {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly limiter: TokenBucketRateLimiter) {}

  run<T>(kind: string, task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      await this.limiter.consume(tokenCost(kind));
      return task();
    });

    // Keep the chain alive even when a task rejects, or one failed request
    // would wedge every subsequent one.
    this.chain = result.catch(() => undefined);
    return result;
  }
}
