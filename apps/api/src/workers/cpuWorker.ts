import { parentPort, workerData } from "node:worker_threads";

function busyLoop(ms: number) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        Math.sqrt(123456.789);
    }
}

const ms: number = workerData?.ms ?? 300;

const t0 = Date.now();
busyLoop(ms);
const t1 = Date.now();

parentPort?.postMessage({ requestedMs: ms, actualMs: t1 - t0 });
