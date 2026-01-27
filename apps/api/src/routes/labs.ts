import { Router } from "express";
import { z } from "zod";

export const labsRouter = Router();

// ----- Memory leak simulation (JS heap growth due to retained references)
let leakTimer: NodeJS.Timeout | null = null;
const leaked: any[] = [];

labsRouter.post("/leak/start", async (req, res, next) => {
    try {
        const schema = z.object({
            mbPerSec: z.coerce.number().min(1).max(200).default(5)
        });
        const { mbPerSec } = schema.parse(req.query);

        if (leakTimer) return res.json({ ok: true, alreadyRunning: true, mbPerSec });

        leakTimer = setInterval(() => {
            // Allocate JS objects that keep references (heap growth)
            // Using strings + arrays makes it very visible in heapUsed.
            const bytes = mbPerSec * 1024 * 1024;

            // Create a big string-ish payload (forces heap allocation)
            const chunk = "x".repeat(1024); // 1KB
            const arr: string[] = [];
            const count = Math.floor(bytes / 1024);

            for (let i = 0; i < count; i++) arr.push(chunk);

            leaked.push(arr);
        }, 1000);

        res.json({ ok: true, started: true, mbPerSec });
    } catch (e) {
        next(e);
    }
});

labsRouter.post("/leak/stop", (_req, res) => {
    if (leakTimer) clearInterval(leakTimer);
    leakTimer = null;
    res.json({ ok: true, stopped: true });
});

labsRouter.post("/leak/clear", (_req, res) => {
    leaked.length = 0;
    // We can hint GC by dropping references; actual memory returns later.
    res.json({ ok: true, cleared: true, retainedArrays: leaked.length });
});

labsRouter.get("/leak/status", (_req, res) => {
    res.json({ running: !!leakTimer, retainedGroups: leaked.length });
});

// ----- Memory retention spike simulation (native buffer allocation)
labsRouter.post("/retention/spike", async (req, res, next) => {
    try {
        const schema = z.object({
            mb: z.coerce.number().min(1).max(2000).default(200),
            holdMs: z.coerce.number().min(0).max(10000).default(250)
        });
        const { mb, holdMs } = schema.parse(req.query);

        // Allocate a large Buffer (native/external memory), then drop it.
        let b = Buffer.alloc(mb * 1024 * 1024, 7);

        // Optional short hold so it shows up on a graph
        if (holdMs > 0) await new Promise(r => setTimeout(r, holdMs));

        // Drop reference (retention behavior: RSS may remain high)
        b = null as any;

        res.json({ ok: true, spikedMb: mb, holdMs });
    } catch (e) {
        next(e);
    }
});