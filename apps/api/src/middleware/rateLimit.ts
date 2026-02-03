import type { Request, Response, NextFunction } from "express";

type Bucket = {
    tokens: number;
    lastRefillMs: number;
};

type RateLimitOptions = {
    name: string;
    capacity: number;        // max tokens
    refillPerSec: number;    // tokens per second
    keyFn?: (req: Request) => string;
    cleanupMs?: number;      // prune idle buckets
};

function nowMs() {
    return Date.now();
}

function clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n));
}

export function rateLimit(opts: RateLimitOptions) {
    const {
        name,
        capacity,
        refillPerSec,
        keyFn = (req) => req.ip || "unknown",
        cleanupMs = 5 * 60_000
    } = opts;

    const buckets = new Map<string, Bucket>();

    // periodic cleanup to avoid unbounded memory
    const interval = setInterval(() => {
        const cut = nowMs() - cleanupMs;
        for (const [k, b] of buckets.entries()) {
            if (b.lastRefillMs < cut) buckets.delete(k);
        }
    }, cleanupMs).unref?.();

    // In case the process shuts down in dev, don't keep interval alive
    if (typeof (interval as any).unref === "function") (interval as any).unref();

    return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
        const key = `${name}:${keyFn(req)}`;
        const t = nowMs();

        let b = buckets.get(key);
        if (!b) {
            b = { tokens: capacity, lastRefillMs: t };
            buckets.set(key, b);
        }

        // refill
        const elapsedSec = (t - b.lastRefillMs) / 1000;
        if (elapsedSec > 0) {
            b.tokens = clamp(b.tokens + elapsedSec * refillPerSec, 0, capacity);
            b.lastRefillMs = t;
        }

        if (b.tokens >= 1) {
            b.tokens -= 1;
            // optional introspection headers (nice for debugging)
            res.setHeader("X-RateLimit-Limit", String(capacity));
            res.setHeader("X-RateLimit-Remaining", String(Math.floor(b.tokens)));
            res.setHeader("X-RateLimit-Policy", `token-bucket; cap=${capacity}; refill=${refillPerSec}/s`);
            return next();
        }

        // calculate retry-after until next token
        const secondsUntilNext = refillPerSec > 0 ? (1 - b.tokens) / refillPerSec : 1;
        const retryAfterSec = Math.ceil(Math.max(0.1, secondsUntilNext));

        res.setHeader("Retry-After", String(retryAfterSec));
        res.status(429).json({
            ok: false,
            error: "rate_limited",
            limiter: name,
            retryAfterSec
        });
    };
}
