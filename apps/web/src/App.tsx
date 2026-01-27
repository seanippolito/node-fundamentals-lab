import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "./api";
import { Graph } from "./Graph";

type FileRow = {
    id: string;
    name: string;
    total_bytes: number;
    created_at: string;
};

type Metrics = {
    ts: string;
    uptimeSec: number;
    memory: Record<string, number>;
    cpuMicro: { user: number; system: number };
    eventLoopDelayMs: Record<string, number>;
};

type MetricsSample = {
    t: number;
    memory: { rss: number; heapUsed: number; external: number };
    ev: { p99: number };
    evMax: { max: number };
};

function formatBytes(n: number) {
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export default function App() {
    const [files, setFiles] = useState<FileRow[]>([]);
    const [sizeMb, setSizeMb] = useState(25);
    const [name, setName] = useState("");
    const [metrics, setMetrics] = useState<Metrics | null>(null);
    const [busy, setBusy] = useState(false);
    const [history, setHistory] = useState<MetricsSample[]>([]);
    const [leakStatus, setLeakStatus] = useState<{ running: boolean; retainedGroups: number } | null>(null);
    const [statusMsg, setStatusMsg] = useState<string | null>(null);
    const [poolStatus, setPoolStatus] = useState<{
        size: number; maxQueue: number; queued: number; running: number; completed: number; rejected: number;
    } | null>(null);
    const [showInterviewNotes, setShowInterviewNotes] = useState(false);

    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const selectedName = useMemo(() => name.trim() || `generated_${sizeMb}MB.bin`, [name, sizeMb]);

    const rssPoints = history.map(s => ({ t: s.t, v: s.memory.rss }));
    const heapPoints = history.map(s => ({ t: s.t, v: s.memory.heapUsed }));
    const extPoints = history.map(s => ({ t: s.t, v: s.memory.external }));
    // const evP99Points = history.map(s => ({ t: s.t, v: s.ev.p99 }));
    const evMaxPoints = history.map(s => ({ t: s.t, v: s.evMax.max }));

    async function refreshFiles() {
        const data = await apiJson<{ files: FileRow[] }>("/files/list");
        setFiles(data.files);
    }

    async function pollMetrics() {
        const data = await apiJson<Metrics>("/metrics/snapshot");
        setMetrics(data);
    }

    async function pollLeakStatus() {
        const s = await apiJson<{ running: boolean; retainedGroups: number }>("/labs/leak/status");
        setLeakStatus(s);
    }

    function flash(msg: string, ms = 2500) {
        setStatusMsg(msg);
        window.setTimeout(() => setStatusMsg(null), ms);
    }

    async function pollPoolStatus() {
        const r = await apiJson<{ ok: boolean; pool: any }>("/cpu/pool/status");
        setPoolStatus(r.pool);
    }

    async function retentionSpike() {
        await apiJson("/labs/retention/spike?mb=300&holdMs=300", { method: "POST" });
    }

    async function startLeak() {
        await apiJson("/labs/leak/start?mbPerSec=5", { method: "POST" });
    }

    async function stopLeak() {
        await apiJson("/labs/leak/stop", { method: "POST" });
    }

    async function clearLeak() {
        await apiJson("/labs/leak/clear", { method: "POST" });
    }

    async function cpuBlock(ms = 500) {
        return apiJson<{ ok: boolean; mode: string; requestedMs: number; actualMs: number }>(`/cpu/block?ms=${ms}`);
    }

    async function cpuWorker(ms = 500) {
        return apiJson<{ ok: boolean; mode: string; requestedMs: number; actualMs: number }>(`/cpu/worker?ms=${ms}`);
    }

    useEffect(() => {
        refreshFiles().catch(console.error);
        pollMetrics().catch(console.error);
        const t = window.setInterval(() => pollMetrics().catch(console.error), 1000);

        pollHistory().catch(console.error);
        const th = window.setInterval(() => pollHistory().catch(console.error), 1000);

        pollLeakStatus().catch(console.error);
        const tl = window.setInterval(() => pollLeakStatus().catch(console.error), 1000);

        // pollCpuStatus().catch(console.error);
        // const tc = window.setInterval(() => pollCpuStatus().catch(console.error), 500);

        pollPoolStatus().catch(console.error);
        const tp = window.setInterval(() => pollPoolStatus().catch(console.error), 500);

        return () => {
            window.clearInterval(t);
            window.clearInterval(th);
            window.clearInterval(tl);
            // window.clearInterval(tc);
            window.clearInterval(tp);
        };
    }, []);

    async function generate() {
        setBusy(true);
        try {
            await apiJson("/files/generate?sizeMb=" + encodeURIComponent(String(sizeMb)) + "&name=" + encodeURIComponent(selectedName), {
                method: "POST"
            });
            await refreshFiles();
        } finally {
            setBusy(false);
        }
    }

    function download(id: string, mode: "buffer" | "stream") {
        // Let browser handle the download
        window.location.href = `/files/${encodeURIComponent(id)}/${mode}`;
    }

    async function del(id: string) {
        setBusy(true);
        try {
            await apiJson(`/files/${encodeURIComponent(id)}`, { method: "DELETE" });
            await refreshFiles();
        } finally {
            setBusy(false);
        }
    }

    async function upload(mode: "memory" | "stream") {
        const input = fileInputRef.current;
        const f = input?.files?.[0];
        if (!f) return;

        setBusy(true);
        try {
            // We send raw bytes (application/octet-stream) for simplicity.
            // That’s perfect for discussing buffering vs streaming in Node.
            const res = await fetch(`/upload/${mode}?name=${encodeURIComponent(f.name)}`, {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: f
            });
            if (!res.ok) throw new Error(await res.text());
            await refreshFiles();
        } finally {
            setBusy(false);
            if (input) input.value = "";
        }
    }

    async function pollHistory() {
        const data = await apiJson<{ samples: any[] }>("/metrics/history?seconds=120");
        // normalize to what we chart
        const samples: MetricsSample[] = data.samples.map(s => ({
            t: s.t,
            memory: {
                rss: s.memory.rss,
                heapUsed: s.memory.heapUsed,
                external: s.memory.external
            },
            ev: {
                p99: s.eventLoopDelayMs?.p99 ?? 0
            },
            evMax: {
                max: s.eventLoopDelayMs?.max ?? 0
            }
        }));
        setHistory(samples);
    }

    return (
        <div className="container">
            <h1>Node Fundamentals Lab</h1>
            <p className="small">
                SQLite-backed chunked BLOB storage. Use this to compare buffering vs streaming, event loop impact, and
                memory behavior.
            </p>

            <div className="row">
                <div className="card">
                    <h2>Generate File (stored in SQLite)</h2>
                    <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                        <label>
                            Size (MB){" "}
                            <input
                                type="number"
                                min={1}
                                max={500}
                                value={sizeMb}
                                onChange={(e) => setSizeMb(Number(e.target.value))}
                            />
                        </label>
                        <label>
                            Name{" "}
                            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional"/>
                        </label>
                        <button onClick={generate} disabled={busy}>
                            Generate
                        </button>
                        <button onClick={() => refreshFiles()} disabled={busy}>
                            Refresh
                        </button>
                    </div>
                    <p className="small">
                        Generation inserts <b>64KB chunks</b> into SQLite. No data directory.
                    </p>
                </div>

                <div className="card">
                    <h2>Metrics (live)</h2>
                    {metrics ? (
                        <pre style={{margin: 0, whiteSpace: "pre-wrap"}}>
                            {JSON.stringify(
                                {
                                    ts: metrics.ts,
                                    uptimeSec: metrics.uptimeSec,
                                    memory: {
                                        rss: formatBytes(metrics.memory.rss),
                                        heapUsed: formatBytes(metrics.memory.heapUsed),
                                        external: formatBytes(metrics.memory.external)
                                    },
                                    eventLoopDelayMs: metrics.eventLoopDelayMs
                                },
                                null,
                                2
                            )}
                        </pre>
                    ) : (
                        <p>Loading…</p>
                    )}
                </div>
            </div>

            <div className="card" style={{marginTop: 16}}>
                <h2>Upload (stores in SQLite)</h2>
                <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                    <input ref={fileInputRef} type="file"/>
                    <button onClick={() => upload("memory")} disabled={busy}>
                        Upload (buffer whole file) ❌
                    </button>
                    <button onClick={() => upload("stream")} disabled={busy}>
                        Upload (stream chunks) ✅
                    </button>
                </div>
                <p className="small">
                    Both endpoints store chunks in SQLite — the difference is whether Node buffers the entire request
                    first.
                </p>
            </div>

            <div className="card" style={{marginTop: 16}}>
                <h2>Files</h2>
                {files.length === 0 ? (
                    <p>No files yet.</p>
                ) : (
                    <div style={{display: "grid", gap: 10}}>
                        {files.map((f) => (
                            <div
                                key={f.id}
                                style={{
                                    border: "1px solid #24243a",
                                    borderRadius: 12,
                                    padding: 12,
                                    display: "grid",
                                    gap: 8
                                }}
                            >
                                <div style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 8,
                                    flexWrap: "wrap"
                                }}>
                                    <div>
                                        <div><b>{f.name}</b></div>
                                        <div className="small">
                                            {f.id} • {formatBytes(f.total_bytes)} • {new Date(f.created_at + "Z").toLocaleString()}
                                        </div>
                                    </div>
                                    <div style={{display: "flex", gap: 8, flexWrap: "wrap"}}>
                                        <button onClick={() => download(f.id, "buffer")} disabled={busy}>
                                            Download (buffer) ❌
                                        </button>
                                        <button onClick={() => download(f.id, "stream")} disabled={busy}>
                                            Download (stream) ✅
                                        </button>
                                        <button onClick={() => del(f.id)} disabled={busy}>
                                            Delete
                                        </button>
                                    </div>
                                </div>
                                <div className="small">
                                    Interview drill: compare RSS/heap/event-loop delay while downloading via buffer vs
                                    stream.
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <p className="small" style={{marginTop: 16}}>
                Tip: open DevTools + watch memory while doing buffered vs streaming operations.
            </p>

            <div className="card" style={{marginTop: 16}}>
                <h2>Memory Graph (last 120s)</h2>

                <div className="row">
                    <div className="card">
                        <Graph
                            title="RSS (process working set)"
                            series={[{name: "rss", points: rssPoints}]}
                            formatValue={formatBytes}
                        />
                        <div className="small" style={{marginTop: 8}}>
                            Retention shows up here: RSS can rise and stay elevated even after work completes.
                        </div>
                    </div>

                    <div className="card">
                        <Graph
                            title="Heap vs External"
                            series={[
                                {name: "heapUsed", points: heapPoints},
                                {name: "external", points: extPoints}
                            ]}
                            formatValue={formatBytes}
                        />
                        <div className="small" style={{marginTop: 8}}>
                            Leaks typically show heapUsed trending upward over time due to retained references.
                        </div>
                    </div>
                </div>

                <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12}}>
                    <button onClick={() => retentionSpike().catch(console.error)} disabled={busy}>
                        Retention spike (allocate + drop)
                    </button>
                    <button onClick={() => startLeak().catch(console.error)} disabled={busy}>
                        Start leak (heap grows)
                    </button>
                    <button onClick={() => stopLeak().catch(console.error)} disabled={busy}>
                        Stop leak
                    </button>
                    <button onClick={() => clearLeak().catch(console.error)} disabled={busy}>
                        Clear leaked refs
                    </button>
                </div>

                <div className="small">
                    Leak
                    status: {leakStatus ? `${leakStatus.running ? "RUNNING" : "stopped"} • groups=${leakStatus.retainedGroups}` : "loading..."}
                </div>
                <div className="small" style={{marginTop: 10}}>
                    Demo idea: click “Download (buffer) ❌” vs “Download (stream) ✅” and watch external/RSS. Then start
                    leak and watch heapUsed climb.
                </div>
            </div>

            <div className="card" style={{marginTop: 16}}>
                <h2>CPU & Event Loop</h2>
                <button
                    style={{marginBottom: 12}}
                    onClick={() => setShowInterviewNotes(v => !v)}
                >
                    {showInterviewNotes ? "Hide" : "Show"} interview notes
                </button>

                {showInterviewNotes && (
                    <div className="card" style={{background: "#101026"}}>
                        <b>Senior interview notes</b>
                        <ul className="small">
                            <li>
                                Node executes JavaScript on a single event-loop thread. Any CPU-heavy
                                JavaScript blocks the entire process.
                            </li>
                            <li>
                                Asynchronous IO does not mean parallel execution. Only worker threads
                                provide true parallelism for JavaScript.
                            </li>
                            <li>
                                CPU-bound workloads must be isolated from the event loop to preserve
                                latency and system responsiveness.
                            </li>
                            <li>
                                Worker threads should be pooled to avoid oversubscription and uncontrolled
                                CPU contention.
                            </li>
                            <li>
                                Backpressure applies to CPU workloads just like network IO — excess work
                                should be queued or rejected, not accepted blindly.
                            </li>
                        </ul>

                        <div className="card" style={{background: "#0d0d1a"}}>
                            <b>Execution model</b>
                            <pre className="small" style={{marginTop: 8}}>
                                {`
                                                ┌─────────────────────────┐
                                                │      Event Loop         │
                                                │   (single JS thread)    │
                                                └───────────┬─────────────┘
                                                            │
                                        ┌───────────────────┴───────────────────┐
                                        │                                       │
                                 CPU-heavy JS                             Async IO
                                 (blocks loop)                           (non-blocking)
                                        │                                       │
                                        ▼                                       ▼
                                  ❌ latency spikes                     OS / libuv
                                  ❌ stalled requests                   callbacks scheduled
                                  ❌ metrics freeze                     event loop stays free
                                
                                
                                 Worker Threads
                                 ─────────────────
                                 Separate JS runtimes
                                 Separate heaps
                                 Separate event loops
                                 Used for CPU-bound work
                                `}
                            </pre>
                        </div>
                    </div>


                )}

                <div className="small" style={{marginBottom: 12}}>
                    These demos illustrate how CPU-heavy JavaScript affects the Node.js event loop,
                    and how worker threads and pooling mitigate those effects.
                </div>
                <Graph
                    title="Event loop delay p99 (ms)"
                    series={[{name: "p99", points: evMaxPoints}]}
                    formatValue={(n) => `${Math.round(n)} ms`}
                />

                <div className="small" style={{marginTop: 8}}>
                    Worker pool:{" "}
                    <b>{poolStatus ? `${poolStatus.running}/${poolStatus.size} running` : "…"}</b>
                    {" • "}
                    queued: <b>{poolStatus ? poolStatus.queued : "…"}</b>
                    {" • "}
                    completed: {poolStatus ? poolStatus.completed : "…"}
                    {" • "}
                    rejected: {poolStatus ? poolStatus.rejected : "…"}
                </div>

                <div className="card">
                    <h3>⚠️ Worker Pool Saturation</h3>

                    <div className="small">
                        Enqueues many CPU jobs at once to demonstrate queueing, throughput limits,
                        and CPU backpressure. When the queue is full, jobs are rejected.
                    </div>

                    <button
                        onClick={async () => {
                            flash("Enqueuing burst of CPU jobs...");
                            await apiJson("/cpu/pool/enqueue?ms=800&n=10", {method: "POST"});
                            flash("Burst submitted.");
                        }}
                    >
                        Enqueue 10 × 800ms
                    </button>
                    <div className="small" style={{marginTop: 6, opacity: 0.8}}>
                        Expected:
                        <ul>
                            <li>running ≤ pool size</li>
                            <li>queued increases</li>
                            <li>rejected increases when saturated</li>
                        </ul>
                    </div>
                </div>

                <div className="card">
                    <h3>❌ CPU Block (Main Thread)</h3>

                    <div className="small">
                        Executes CPU-heavy JavaScript directly on the event loop thread.
                        While this runs, <b>all requests stall</b> and event loop delay spikes.
                    </div>

                    <button
                        onClick={async () => {
                            flash("CPU block started (main thread)...");
                            await cpuBlock(800);
                            flash("CPU block finished.");
                        }}
                    >
                        CPU block 800ms
                    </button>
                    <div className="small" style={{marginTop: 6, opacity: 0.8}}>
                        Expected:
                        <ul>
                            <li>Event loop delay spikes</li>
                            <li>Other requests temporarily stall</li>
                            <li>UI polling pauses</li>
                            <li>metrics temporarily stop</li>
                        </ul>
                    </div>
                </div>

                <div className="card">
                    <h3>✅ CPU Worker (Pooled)</h3>

                    <div className="small">
                        Offloads CPU work to a worker thread from a fixed-size pool.
                        The event loop remains responsive while work executes in parallel.
                    </div>

                    <button
                        onClick={async () => {
                            flash("CPU worker job submitted...");
                            await cpuWorker(800);
                            flash("CPU worker job completed.");
                        }}
                    >
                        CPU worker 800ms
                    </button>
                    <div className="small" style={{marginTop: 6, opacity: 0.8}}>
                        Expected:
                        <ul>
                            <li>event loop delay mostly flat</li>
                            <li>memory stable</li>
                            <li>UI responsive</li>
                        </ul>
                    </div>
                </div>
                {statusMsg && (
                    <div
                        className="card"
                        style={{
                            marginTop: 12,
                            borderColor: "#3a3a64",
                            background: "#101026"
                        }}
                    >
                        <b>Status:</b> {statusMsg}
                    </div>
                )}
            </div>
        </div>
    );
}
