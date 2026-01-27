import { parentPort } from "node:worker_threads";

function busyLoop(ms: number) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        Math.sqrt(123456.789);
    }
}

parentPort?.on("message", (msg: any) => {
    const id = msg?.id;
    const ms = msg?.ms;

    if (typeof id !== "number" || typeof ms !== "number") return;

    const t0 = Date.now();
    busyLoop(ms);
    const t1 = Date.now();

    parentPort?.postMessage({ id, requestedMs: ms, actualMs: t1 - t0 });
});
