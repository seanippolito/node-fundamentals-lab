import type { Request, Response } from "express";
import { eventBus, RtEvent } from "./eventBus.js";
import crypto from "node:crypto";

type SseConn = {
    id: string;
    res: Response;
    connectedAt: number;

    // backpressure state
    blocked: boolean;           // true when res.write returned false
    blockedSince: number | null;
    queue: string[];            // queued SSE frames
    queuedBytes: number;
    dropped: number;
    lastDrainAt: number | null;

    // counters
    sentEvents: number;
};

const conns = new Map<string, SseConn>();

const HEARTBEAT_MS = 15_000;

// limits: protect the server from slow consumers
const MAX_QUEUE_BYTES = 512 * 1024;  // 512KB per connection
const MAX_QUEUE_FRAMES = 200;        // cap frames too
const MAX_BLOCKED_MS = 10_000;  // 10s blocked -> disconnect
const MAX_DROPPED = 500;        // too many drops -> disconnect

function sseFrame(evt: RtEvent): string {
    // Keep `id:` as seq so Last-Event-ID works
    // Also include seq in JSON so client can parse consistently
    return (
        `id: ${evt.seq}\n` +
        `event: ${evt.type}\n` +
        `data: ${JSON.stringify(evt)}\n\n`
    );
}

function writeOrQueue(conn: SseConn, frame: string) {
    if (conn.res.writableEnded) return;

    if (!conn.blocked) {
        const ok = conn.res.write(frame);
        if (ok) {
            conn.sentEvents += 1;
            return;
        }
        // entered backpressure
        conn.blocked = true;
        conn.blockedSince = conn.blockedSince ?? Date.now();
    }

    // queue if blocked
    conn.queue.push(frame);
    conn.queuedBytes += Buffer.byteLength(frame);

    // enforce limits
    while (conn.queue.length > MAX_QUEUE_FRAMES || conn.queuedBytes > MAX_QUEUE_BYTES) {
        const dropped = conn.queue.shift();
        if (!dropped) break;
        conn.queuedBytes -= Buffer.byteLength(dropped);
        conn.dropped += 1;
    }

    const blockedFor = conn.blockedSince ? Date.now() - conn.blockedSince : 0;
    if (blockedFor > MAX_BLOCKED_MS || conn.dropped > MAX_DROPPED) {
        // This client is too slow; close it to protect the server
        try { conn.res.end(); } catch {}
    }
}

function flushQueue(conn: SseConn) {
    if (conn.res.writableEnded) return;

    conn.blocked = false;
    conn.blockedSince = null;
    conn.lastDrainAt = Date.now();

    while (conn.queue.length > 0) {
        const frame = conn.queue[0]!;
        const ok = conn.res.write(frame);
        if (!ok) {
            conn.blocked = true; // still blocked, wait for next drain
            conn.blockedSince = conn.blockedSince ?? Date.now();
            return;
        }
        conn.queue.shift();
        conn.queuedBytes -= Buffer.byteLength(frame);
        conn.sentEvents += 1;
    }
}

// Expose status to UI
export function getSseStatus() {
    return Array.from(conns.values()).map((c) => ({
        id: c.id,
        connectedAt: c.connectedAt,
        ageMs: Date.now() - c.connectedAt,
        blocked: c.blocked,
        queueLen: c.queue.length,
        queuedBytes: c.queuedBytes,
        dropped: c.dropped,
        lastDrainAt: c.lastDrainAt,
        sentEvents: c.sentEvents
    }));
}

export function sseHandler(req: Request, res: Response) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const id = crypto.randomUUID();
    const conn: SseConn = {
        id,
        res,
        connectedAt: Date.now(),
        blocked: false,
        blockedSince: null,
        queue: [],
        queuedBytes: 0,
        dropped: 0,
        lastDrainAt: null,
        sentEvents: 0
    };
    conns.set(id, conn);

    // Important: flush queued data when the underlying stream drains
    res.on("drain", () => flushQueue(conn));
    res.socket?.on("drain", () => flushQueue(conn));

    // Retry flushing even if drain doesn't fire reliably (dev/proxy environments)
    const flushTick = setInterval(() => {
        if (conn.blocked && conn.queue.length > 0) {
            flushQueue(conn);
        }
    }, 100);

    // initial comment
    res.write(`: connected ${new Date().toISOString()} id=${id}\n\n`);

    // replay from Last-Event-ID
    const lastId = req.header("Last-Event-ID");
    const afterSeq = lastId != null ? Number(lastId) : 0;
    const replay = eventBus.replayAfterSeq(Number.isFinite(afterSeq) ? afterSeq : 0, 200);
    for (const evt of replay) {
        writeOrQueue(conn, sseFrame(evt));
    }

    // live subscription
    const unsubscribe = eventBus.subscribe((evt) => {
        writeOrQueue(conn, sseFrame(evt));
    });

    const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
            // comments are cheap; also useful for keeping connections alive
            const ok = res.write(`: heartbeat ${Date.now()}\n\n`);
            if (!ok) {
                conn.blocked = true;
                conn.blockedSince = conn.blockedSince ?? Date.now();
            }
        }
    }, HEARTBEAT_MS);

    const cleanup = () => {
        clearInterval(heartbeat);
        clearInterval(flushTick);
        unsubscribe();
        conns.delete(id);
        try { res.end(); } catch {}
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
}
