import { Router } from "express";
import { z } from "zod";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const cpuRouter = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let inFlightBlock = 0;
let inFlightWorker = 0;

function snapshotStatus() {
    return {
        inFlight: inFlightBlock + inFlightWorker,
        inFlightBlock,
        inFlightWorker
    };
}

function busyLoop(ms: number) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        Math.sqrt(123456.789);
    }
}

cpuRouter.get("/block", (req, res, next) => {
    inFlightBlock++;
    try {
        const schema = z.object({
            ms: z.coerce.number().min(1).max(30_000).default(300)
        });
        const { ms } = schema.parse(req.query);

        const t0 = Date.now();
        busyLoop(ms);
        const t1 = Date.now();

        res.json({
            ok: true,
            mode: "block",
            requestedMs: ms,
            actualMs: t1 - t0,
            ...snapshotStatus()
        });
    } catch (e) {
        next(e);
    } finally {
        inFlightBlock--;
    }
});

cpuRouter.get("/worker", async (req, res, next) => {
    inFlightWorker++;
    try {
        const schema = z.object({
            ms: z.coerce.number().min(1).max(30_000).default(300)
        });
        const { ms } = schema.parse(req.query);

        const runningWithTsx =
            process.argv.some(a => a.includes("tsx")) ||
            process.execArgv.some(a => a.includes("tsx")) ||
            process.env.TSX === "true";

        const workerFile = runningWithTsx ? "cpuWorker.ts" : "cpuWorker.js";
        const workerPath = path.join(__dirname, "..", "workers", workerFile);

        const result = await new Promise<{ requestedMs: number; actualMs: number }>((resolve, reject) => {
            const w = new Worker(workerPath, {
                workerData: { ms },
                execArgv: runningWithTsx ? ["--import", "tsx"] : undefined
            });

            w.once("message", (msg) => resolve(msg));
            w.once("error", reject);
            w.once("exit", (code) => {
                if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
            });
        });

        res.json({ ok: true, mode: "worker", ...result, ...snapshotStatus() });
    } catch (e) {
        next(e);
    } finally {
        inFlightWorker--;
    }
});

cpuRouter.get("/status", (_req, res) => {
    res.json({ ok: true, ...snapshotStatus() });
});

