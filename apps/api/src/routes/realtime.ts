import { Router } from "express";
import crypto from "node:crypto";
import { eventBus } from "../realtime/eventBus.js";
import { sseHandler } from "../realtime/sse.js";
import { recordWebhookOnce } from "../realtime/webhookDb.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { getSseStatus } from "../realtime/sse.js";

export const realtimeRouter = Router();

// Polling can be extremely chatty; protect the server.
const pollLimiter = rateLimit({
    name: "poll",
    capacity: 2,       // burst
    refillPerSec: 1    // sustained
});

// Webhooks should be protected too (esp. retries/abuse).
const webhookLimiter = rateLimit({
    name: "webhook",
    capacity: 2,
    refillPerSec: 0.5
});


// SSE stream
realtimeRouter.get("/sse", sseHandler);

realtimeRouter.get("/sse/status", (req, res) => {
    res.json({ ok: true, conns: getSseStatus() });
});

realtimeRouter.post("/sse/spam", async (req, res) => {
    const kb = Math.max(1, Math.min(512, Number(req.query.kb ?? 64)));
    const count = Math.max(1, Math.min(500, Number(req.query.count ?? 200)));
    const paceMs = Math.max(0, Math.min(50, Number(req.query.paceMs ?? 2))); // <-- NEW

    const payload = "x".repeat(kb * 1024);

    for (let i = 0; i < count; i++) {
        eventBus.publish("sse.spam", { i, kb, payload });

        // yield so sockets can flush + 'drain' can fire
        if (paceMs > 0) await new Promise(r => setTimeout(r, paceMs));
        else await new Promise(r => setImmediate(r));
    }

    res.json({ ok: true, kb, count, paceMs });
});


realtimeRouter.get("/poll", pollLimiter, async (req, res) => {
    const afterSeqRaw = typeof req.query.afterSeq === "string" ? req.query.afterSeq : undefined;
    const afterSeqParsed = afterSeqRaw != null ? Number(afterSeqRaw) : NaN;
    const afterSeq = Number.isFinite(afterSeqParsed) ? afterSeqParsed : 0; // <-- default to 0


    const timeoutMsRaw = typeof req.query.timeoutMs === "string" ? req.query.timeoutMs : "0";
    const timeoutMs = Math.max(0, Math.min(30_000, Number(timeoutMsRaw) || 0)); // clamp to 30s

    const LIMIT = 500;

    // 1) If events already exist after cursor, return immediately (batch)
    const immediate = eventBus.replayAfterSeq(afterSeq, LIMIT);
    if (immediate.length > 0 || timeoutMs === 0) {
        const cursor = immediate.length ? immediate[immediate.length - 1].seq : afterSeq;
        return res.json({ ok: true, mode: timeoutMs === 0 ? "short" : "long", events: immediate, cursor });
    }

    // 2) Long poll: wait until ANY event arrives, then batch return everything since cursor
    let finished = false;

    const result = await new Promise<{ events: any[]; cursor: number | null }>((resolve) => {
        const unsub = eventBus.subscribe(() => {
            if (finished) return;
            finished = true;
            unsub();

            const events = eventBus.replayAfterSeq(afterSeq, LIMIT);
            const cursor = events.length ? events[events.length - 1].seq : afterSeq;
            resolve({ events, cursor });
        });

        const t = setTimeout(() => {
            if (finished) return;
            finished = true;
            unsub();
            resolve({ events: [], cursor: afterSeq });
        }, timeoutMs);

        // clear timeout when resolved early
        const originalResolve = resolve;
        resolve = ((payload: any) => {
            clearTimeout(t);
            originalResolve(payload);
        }) as any;
    });

    return res.json({ ok: true, mode: "long", events: result.events, cursor: result.cursor });
});


// Demo publish endpoint (useful for testing quickly)
realtimeRouter.post("/publish", (req, res) => {
    const { type, data } = req.body ?? {};
    const evt = eventBus.publish(type ?? "demo.event", data ?? { ok: true });
    res.json({ ok: true, event: evt });
});

realtimeRouter.post("/webhook", webhookLimiter, async (req, res) => {
    const secret = process.env.WEBHOOK_SECRET || "dev_secret_change_me";
    const signature = req.header("x-signature") || "";
    const bodyBuf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

    const expected = crypto
        .createHmac("sha256", secret)
        .update(bodyBuf)
        .digest("hex");

    const sigOk =
        signature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

    if (!sigOk) {
        return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    let payload: any;
    try {
        payload = JSON.parse(bodyBuf.toString("utf8"));
    } catch {
        return res.status(400).json({ ok: false, error: "invalid json" });
    }

    const eventId = String(payload?.id || payload?.eventId || "");
    if (!eventId) {
        return res.status(400).json({ ok: false, error: "missing event id" });
    }

    const { inserted } = await recordWebhookOnce({
        id: eventId,
        source: payload?.source,
        payload
    });

    if (!inserted) {
        return res.json({ ok: true, duplicate: true });
    }

    eventBus.publish("webhook.received", payload);

    res.json({ ok: true });
});


export default realtimeRouter;
