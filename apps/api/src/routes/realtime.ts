import { Router } from "express";
import crypto from "node:crypto";
import { eventBus } from "../realtime/eventBus.js";
import { sseHandler } from "../realtime/sse.js";
import { recordWebhookOnce } from "../realtime/webhookDb.js";
import express from "express";

export const realtimeRouter = Router();

// SSE stream
realtimeRouter.get("/sse", sseHandler);

// Demo publish endpoint (useful for testing quickly)
realtimeRouter.post("/publish", (req, res) => {
    const { type, data } = req.body ?? {};
    const evt = eventBus.publish(type ?? "demo.event", data ?? { ok: true });
    res.json({ ok: true, event: evt });
});

const rawJson = express.raw({ type: "application/json", limit: "2mb" });

realtimeRouter.post("/webhook", rawJson, async (req, res) => {
    console.log("[webhook] secret length:");



    const secret = process.env.WEBHOOK_SECRET || "dev_secret_change_me";
    const signature = req.header("x-signature") || "";
    const bodyBuf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    console.log("[webhook] secret length:", secret.length);

    const expected = crypto
        .createHmac("sha256", secret)
        .update(bodyBuf)
        .digest("hex");
    console.log("[webhook] expected:", expected, "got:", signature, "bodyLen:", bodyBuf.length);
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
