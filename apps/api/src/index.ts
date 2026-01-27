import express from "express";
import cors from "cors";
import compression from "compression";
import pino from "pino";
import pinoHttp from "pino-http";
import { filesRouter } from "./routes/files.js";
import { uploadsRouter } from "./routes/uploads.js";
import { startMetricsRecorder, getMetricsHistory, getMetricsSnapshot } from "./metrics.js";
import { labsRouter } from "./routes/labs.js";
import { cpuRouter } from "./routes/cpu.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const app = express();

app.use(
    pinoHttp({
        logger: log,
        genReqId: (req) => (req.headers["x-request-id"] as string) ?? crypto.randomUUID()
    })
);

app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const end = process.hrtime.bigint();
        const ms = Number(end - start) / 1e6;
        // keep it simple; you can evolve this into histogram metrics
        req.log.info(
            { method: req.method, path: req.originalUrl, status: res.statusCode, durMs: ms.toFixed(2) },
            "request"
        );
    });
    next();
});

app.use(cors());
app.use(compression());

// Keep JSON small so upload endpoints force you to think about streaming
app.use(express.json({ limit: "256kb" }));

// start recorder near startup (after app creation is fine)
startMetricsRecorder(1000);

app.get("/health", (_req, res) => res.json({ ok: true }));

// replace your existing /metrics/snapshot handler with these:
app.get("/metrics/snapshot", (_req, res) => {
    res.json(getMetricsSnapshot());
});

app.get("/metrics/history", (req, res) => {
    const seconds = Number(req.query.seconds ?? 60);
    res.json({ samples: getMetricsHistory(Number.isFinite(seconds) ? seconds : 60) });
});

// add this:
app.use("/labs", labsRouter);
app.use("/files", filesRouter);
app.use("/upload", uploadsRouter);
app.use("/cpu", cpuRouter);

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = err?.message ?? "unknown error";
    const details = err?.issues ?? err?.stack ?? String(err);
    res.status(500).json({ error: msg, details });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
    log.info({ port }, "API listening");
});
