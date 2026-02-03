import type { Request, Response } from "express";
import { eventBus, RtEvent } from "./eventBus.js";

function writeSse(res: Response, evt: RtEvent) {
    // SSE format:
    // id: <seq>
    // event: <type>
    // data: <json>
    // \n
    res.write(`id: ${evt.seq}\n`);              // <-- seq cursor
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify({ ...evt, room: undefined })}\n\n`);
}

// Heartbeat to keep proxies from closing idle connections
const HEARTBEAT_MS = 15_000;

export function sseHandler(req: Request, res: Response) {
    // Required SSE headers
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // If behind Nginx, this disables response buffering:
    res.setHeader("X-Accel-Buffering", "no");

    // Send an initial comment to open the stream
    res.write(`: connected ${new Date().toISOString()}\n\n`);

    // Replay if client provided Last-Event-ID header
    const lastId = req.header("Last-Event-ID") ?? undefined;
    const afterSeq = lastId != null ? Number(lastId) : undefined;

    const replay = eventBus.replayAfterSeq(afterSeq, 200);
    for (const evt of replay) writeSse(res, evt);

    const unsubscribe = eventBus.subscribe((evt) => {
        // Optional: if you later want room filtering, add a ?room=... and check here.
        writeSse(res, evt);
    });

    const heartbeat = setInterval(() => {
        // comment line is ignored by SSE clients
        res.write(`: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { res.end(); } catch {}
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
}
