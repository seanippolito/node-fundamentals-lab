import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Job = {
    id: number;
    ms: number;
    enqueuedAt: number;
    resolve: (v: { requestedMs: number; actualMs: number }) => void;
    reject: (e: Error) => void;
};

type WorkerSlot = {
    worker: Worker;
    busy: boolean;
    currentJobId: number | null;
};

export type PoolStatus = {
    size: number;
    maxQueue: number;
    queued: number;
    running: number;
    completed: number;
    rejected: number;
};

function isRunningFromDist(dirname: string) {
    return dirname.includes(`${path.sep}dist${path.sep}`) || dirname.endsWith(`${path.sep}dist`);
}

function runningWithTsx() {
    return (
        process.argv.some(a => a.includes("tsx")) ||
        process.execArgv.some(a => a.includes("tsx")) ||
        process.env.TSX === "true"
    );
}

function getWorkerPath() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // pool.ts is in src/cpuPool (dev) or dist/cpuPool (prod)
    const fromDist = isRunningFromDist(__dirname);

    // worker lives in ../workers/
    if (fromDist) {
        return path.join(__dirname, "..", "workers", "cpuWorker.js");
    }

    // dev: run TS worker via tsx loader
    return path.join(__dirname, "..", "workers", "cpuWorker.ts");
}

export class CpuWorkerPool {
    private slots: WorkerSlot[] = [];
    private queue: Job[] = [];
    private nextJobId = 1;

    private completed = 0;
    private rejected = 0;

    constructor(
        private readonly size: number,
        private readonly maxQueue: number
    ) {
        const workerPath = getWorkerPath();
        const useTsx = !isRunningFromDist(path.dirname(fileURLToPath(import.meta.url))) && runningWithTsx();

        for (let i = 0; i < size; i++) {
            const w = new Worker(workerPath, {
                execArgv: useTsx ? ["--import", "tsx"] : undefined
            });

            const slot: WorkerSlot = { worker: w, busy: false, currentJobId: null };
            this.slots.push(slot);

            w.on("message", (msg: any) => {
                // Expected: { id, requestedMs, actualMs }
                const id = msg?.id;
                if (typeof id !== "number") return;

                const jobIndex = this.queue.findIndex(j => j.id === id);
                // NOTE: once a job is assigned to a slot, it is removed from queue,
                // so we should resolve via "inFlight" map. We'll do that below.
            });

            w.on("error", (err) => {
                // If a worker errors while busy, fail that job and replace worker
                const jobId = slot.currentJobId;
                if (jobId != null) {
                    this.failInFlight(jobId, err instanceof Error ? err : new Error(String(err)));
                }
                this.replaceWorker(slot);
            });

            w.on("exit", (code) => {
                if (code !== 0) {
                    const jobId = slot.currentJobId;
                    if (jobId != null) {
                        this.failInFlight(jobId, new Error(`Worker exited with code ${code}`));
                    }
                    this.replaceWorker(slot);
                }
            });
        }

        // Hook messages after worker creation (needs inFlight map)
        for (const slot of this.slots) {
            slot.worker.on("message", (msg: any) => this.onWorkerMessage(slot, msg));
        }
    }

    // Track only jobs that have been dispatched to a worker
    private inFlight = new Map<number, Job>();

    private onWorkerMessage(slot: WorkerSlot, msg: any) {
        const id = msg?.id;
        if (typeof id !== "number") return;

        const job = this.inFlight.get(id);
        if (!job) return;

        this.inFlight.delete(id);
        slot.busy = false;
        slot.currentJobId = null;

        this.completed++;
        job.resolve({ requestedMs: msg.requestedMs, actualMs: msg.actualMs });

        this.drain();
    }

    private failInFlight(id: number, err: Error) {
        const job = this.inFlight.get(id);
        if (!job) return;
        this.inFlight.delete(id);
        job.reject(err);
    }

    private async replaceWorker(slot: WorkerSlot) {
        try { await slot.worker.terminate(); } catch {}

        const workerPath = getWorkerPath();
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const fromDist = isRunningFromDist(__dirname);
        const useTsx = !fromDist && runningWithTsx();

        const w = new Worker(workerPath, {
            execArgv: useTsx ? ["--import", "tsx"] : undefined
        });

        slot.worker = w;
        slot.busy = false;
        slot.currentJobId = null;

        w.on("message", (msg: any) => this.onWorkerMessage(slot, msg));
        w.on("error", (err) => {
            const jobId = slot.currentJobId;
            if (jobId != null) this.failInFlight(jobId, err instanceof Error ? err : new Error(String(err)));
            this.replaceWorker(slot);
        });
        w.on("exit", (code) => {
            if (code !== 0) {
                const jobId = slot.currentJobId;
                if (jobId != null) this.failInFlight(jobId, new Error(`Worker exited with code ${code}`));
                this.replaceWorker(slot);
            }
        });
    }

    status(): PoolStatus {
        const running = this.slots.filter(s => s.busy).length;
        return {
            size: this.size,
            maxQueue: this.maxQueue,
            queued: this.queue.length,
            running,
            completed: this.completed,
            rejected: this.rejected
        };
    }

    submit(ms: number): Promise<{ requestedMs: number; actualMs: number }> {
        if (this.queue.length >= this.maxQueue) {
            this.rejected++;
            return Promise.reject(Object.assign(new Error("CPU pool saturated (queue full)"), { code: "POOL_FULL" }));
        }

        const id = this.nextJobId++;
        return new Promise((resolve, reject) => {
            this.queue.push({
                id,
                ms,
                enqueuedAt: Date.now(),
                resolve,
                reject
            });
            this.drain();
        });
    }

    // Assign queued jobs to idle workers
    private drain() {
        for (const slot of this.slots) {
            if (slot.busy) continue;
            const job = this.queue.shift();
            if (!job) return;

            slot.busy = true;
            slot.currentJobId = job.id;
            this.inFlight.set(job.id, job);

            slot.worker.postMessage({ id: job.id, ms: job.ms });
        }
    }
}
