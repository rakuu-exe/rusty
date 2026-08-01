import { describe, expect, it } from 'vitest';
import { RateLimitedQueue, TokenBucketRateLimiter, tokenCost } from '../src/rustplus/rateLimiter.js';

/** Controllable clock so these tests never actually wait. */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('tokenCost', () => {
  it('knows the documented non-default costs', () => {
    expect(tokenCost('getMap')).toBe(5);
    expect(tokenCost('sendTeamMessage')).toBe(2);
    expect(tokenCost('getMapMarkers')).toBe(1);
  });

  it('falls back to 1 for anything unlisted', () => {
    expect(tokenCost('someFutureCall')).toBe(1);
  });
});

describe('TokenBucketRateLimiter', () => {
  it('defaults to the per-playerId bucket Facepunch enforces', () => {
    const limiter = new TokenBucketRateLimiter();
    expect(limiter.available).toBe(25);
  });

  it('drains and refills at 3 tokens per second', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ now: clock.now });

    expect(limiter.tryConsume(25)).toBe(true);
    expect(limiter.available).toBe(0);

    clock.advance(1000);
    expect(limiter.available).toBeCloseTo(3, 5);

    clock.advance(1000);
    expect(limiter.available).toBeCloseTo(6, 5);
  });

  it('refuses to overdraw', () => {
    const limiter = new TokenBucketRateLimiter({ now: fakeClock().now });
    expect(limiter.tryConsume(25)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false);
  });

  it('never refills past capacity', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ now: clock.now });

    clock.advance(60_000);
    expect(limiter.available).toBe(25);
  });

  it('reports how long until a request can run', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ now: clock.now });

    limiter.tryConsume(25);
    // getMap costs 5 tokens; at 3/sec that is 5/3 seconds.
    expect(limiter.delayFor(5)).toBe(1667);
    expect(limiter.delayFor(0)).toBe(0);
  });

  it('rejects a request larger than the bucket instead of hanging forever', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 4 });
    expect(() => limiter.delayFor(5)).toThrow(/only holds/);
  });

  it('sustains a 5s poll indefinitely', () => {
    // The real safety property: POLL_INTERVAL_MS=5000 costs 1 token per poll
    // against a 3/sec refill, so the bucket should stay full.
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ now: clock.now });

    for (let i = 0; i < 200; i++) {
      expect(limiter.tryConsume(1)).toBe(true);
      clock.advance(5000);
    }

    expect(limiter.available).toBe(25);
  });
});

describe('RateLimitedQueue', () => {
  it('runs tasks in submission order', async () => {
    const queue = new RateLimitedQueue(new TokenBucketRateLimiter());
    const order: number[] = [];

    await Promise.all([
      queue.run('getInfo', async () => void order.push(1)),
      queue.run('getInfo', async () => void order.push(2)),
      queue.run('getInfo', async () => void order.push(3)),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps running after a task rejects', async () => {
    // A single failed request must not wedge every later one -- this is what
    // keeps one timed-out poll from stopping the bot permanently.
    const queue = new RateLimitedQueue(new TokenBucketRateLimiter());

    await expect(queue.run('getInfo', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue.run('getInfo', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('propagates results', async () => {
    const queue = new RateLimitedQueue(new TokenBucketRateLimiter());
    await expect(queue.run('getInfo', () => Promise.resolve(42))).resolves.toBe(42);
  });
});
