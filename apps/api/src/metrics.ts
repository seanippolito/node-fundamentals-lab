import { monitorEventLoopDelay } from "node:perf_hooks";

const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();

export type MetricsSample = ReturnType<typeof getMetricsSnapshot> & { t: number };

const HISTORY_MAX_SAMPLES = 5 * 60; // keep last 5 minutes @ 1Hz
const history: MetricsSample[] = [];

let recorderStarted = false;

export function getMetricsSnapshot() {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();

    return {
        ts: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        memory: {
            rss: mem.rss,
            heapTotal: mem.heapTotal,
            heapUsed: mem.heapUsed,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers
        },
        cpuMicro: {
            user: cpu.user,
            system: cpu.system
        },
        eventLoopDelayMs: {
            min: Math.round(h.min / 1e6),
            max: Math.round(h.max / 1e6),
            mean: Math.round(h.mean / 1e6),
            p50: Math.round(h.percentile(50) / 1e6),
            p90: Math.round(h.percentile(90) / 1e6),
            p99: Math.round(h.percentile(99) / 1e6)
        }
    };
}

export function startMetricsRecorder(sampleEveryMs = 1000) {
    if (recorderStarted) return;
    recorderStarted = true;

    setInterval(() => {
        const snap = getMetricsSnapshot();
        history.push({ ...snap, t: Date.now() });
        while (history.length > HISTORY_MAX_SAMPLES) history.shift();
    }, sampleEveryMs).unref();
}

export function getMetricsHistory(seconds = 60) {
    const cutoff = Date.now() - seconds * 1000;
    return history.filter(s => s.t >= cutoff);
}