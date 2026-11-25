interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  consume(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || now >= existing.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (existing.count >= this.maxRequests) {
      return { allowed: false, retryAfterMs: existing.resetAt - now };
    }

    existing.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
  }
}

export const roomCreateLimiter = new RateLimiter(8, 60_000);
export const roomJoinPasswordLimiter = new RateLimiter(10, 60_000);
export const chatLimiter = new RateLimiter(20, 15_000);
export const guessLimiter = new RateLimiter(6, 15_000);
