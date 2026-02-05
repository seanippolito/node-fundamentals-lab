import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "../api"; // adjust path if your api helper lives elsewhere

type FeedEvent = {
    seq: number;
    type: string;
    ts: number;
    data: any;
};

type SseConnStatus = {
    id: string;
    connectedAt: number;
    ageMs: number;
    blocked: boolean;
    queueLen: number;
    queuedBytes: number;
    dropped: number;
    lastDrainAt: number | null;
    sentEvents: number;
};

function nowIso() {
    return new Date().toISOString().slice(11, 19);
}

function InterviewNotes({
                            title,
                            children,
                            defaultOpen = false
                        }: {
    title: string;
    children: React.ReactNode;
    defaultOpen?: boolean;
}) {
    return (
        <details className="notes" open={defaultOpen}>
            <summary>{title}</summary>
            <div className="notes__body">{children}</div>
        </details>
    );
}

function NotesList({ items }: { items: string[] }) {
    return (
        <ul className="notes__list">
            {items.map((t, i) => (
                <li key={i}>{t}</li>
            ))}
        </ul>
    );
}

export function RealtimeLab() {
    // ---- SSE
    const [sseConnected, setSseConnected] = useState(false);
    const [sseReconnects, setSseReconnects] = useState(0);
    const [lastSeq, setLastSeq] = useState<number | null>(null);
    const [feed, setFeed] = useState<FeedEvent[]>([]);
    const [sseStatus, setSseStatus] = useState<SseConnStatus[]>([]);
    const esRef = useRef<EventSource | null>(null);
    const seenSeqsRef = useRef<Set<number>>(new Set());

    const appendFeed = (evt: FeedEvent) => {
        if (seenSeqsRef.current.has(evt.seq)) return;
        seenSeqsRef.current.add(evt.seq);
        // Keep the Set bounded to avoid memory growth
        if (seenSeqsRef.current.size > 250) {
            const seqs = Array.from(seenSeqsRef.current);
            seenSeqsRef.current = new Set(seqs.slice(-200));
        }
        setFeed(prev => [evt, ...prev].slice(0, 200));
        setLastSeq(evt.seq);
    };


    const connectSse = () => {
        if (esRef.current) esRef.current.close();

        const es = new EventSource("/realtime/sse");
        esRef.current = es;

        es.onopen = () => setSseConnected(true);

        es.onerror = () => {
            setSseConnected(false);
            setSseReconnects((n) => n + 1);
        };

        // IMPORTANT: Never JSON.parse very large SSE frames in the browser.
        // Parsing + rendering huge payloads makes the browser a slow consumer,
        // which causes permanent backpressure on the server.
        es.onmessage = (m) => {
            try {
                const data = m.data;
                if (typeof data === "string" && data.length > 20_000) {
                    const seq = Number((m as any).lastEventId);
                    if (Number.isFinite(seq) && seq > 0) {
                        appendFeed({
                            seq,
                            type: "message",
                            ts: Date.now(),
                            data: { note: "payload omitted (large SSE frame)" }
                        });
                    }
                    return;
                }

                const parsed = JSON.parse(data);
                const seq = Number(parsed.seq);
                if (!Number.isFinite(seq) || seq <= 0) return;

                appendFeed({
                    seq,
                    type: parsed.type ?? "message",
                    ts: parsed.ts ?? Date.now(),
                    data: parsed.data
                });
            } catch {}
        };

        // Typed spam event handler: never parse payload
        es.addEventListener("sse.spam", (m: MessageEvent) => {
            const seq = Number((m as any).lastEventId);
            if (!Number.isFinite(seq) || seq <= 0) return;

            appendFeed({
                seq,
                type: "sse.spam",
                ts: Date.now(),
                data: { note: "payload omitted (large spam)" }
            });
        });

        const known = ["webhook.received", "ws.connected", "ws.disconnected", "ws.joined", "ws.message", "demo.event"];
        known.forEach((t) => {
            es.addEventListener(t, (m: any) => {
                try {
                    const parsed = JSON.parse(m.data);
                    const seq = Number(parsed.seq);
                    if (!Number.isFinite(seq) || seq <= 0) return;
                    appendFeed({ seq, type: parsed.type ?? "message", ts: parsed.ts ?? Date.now(), data: parsed.data });
                } catch {}
            });
        });
    };

    const spamSse = async (kb: number, count: number, paceMs = 2) => {
        await fetch(`/realtime/sse/spam?kb=${kb}&count=${count}&paceMs=${paceMs}`, { method: "POST" });
    };

    const disconnectSse = () => {
        esRef.current?.close();
        esRef.current = null;
        setSseConnected(false);
    };

    // ---- WS
    const [wsConnected, setWsConnected] = useState(false);
    const [wsRoom, setWsRoom] = useState("lobby");
    const [wsClientId, setWsClientId] = useState<string | null>(null);
    const [wsText, setWsText] = useState("hello");
    const wsRef = useRef<WebSocket | null>(null);

    const connectWs = () => {
        if (wsRef.current) wsRef.current.close();

        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${window.location.host}/realtime/ws`);
        wsRef.current = ws;

        ws.onopen = () => setWsConnected(true);
        ws.onclose = () => setWsConnected(false);
        ws.onerror = () => setWsConnected(false);

        ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === "hello") {
                    setWsClientId(msg.clientId);
                    setWsRoom(msg.room);
                    return;
                }
                if (msg.type === "msg") {
                    appendFeed({ seq: msg.seq ?? Date.now(), type: "ws.broadcast", ts: msg.ts ?? Date.now(), data: msg });
                    return;
                }
            } catch {}
        };
    };

    const disconnectWs = () => {
        wsRef.current?.close();
        wsRef.current = null;
        setWsConnected(false);
    };

    const joinRoom = () => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(JSON.stringify({ type: "join", room: wsRoom }));
    };

    const sendWs = () => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(JSON.stringify({ type: "say", room: wsRoom, text: wsText }));
        // 🔔 (future) This is where debouncing might apply if you send on every keystroke.
    };

    // ---- Webhook tester
    const [webhookId, setWebhookId] = useState(() => `evt_${Date.now()}`);
    const [webhookSecret, setWebhookSecret] = useState("24ea1693de814d74ce7e5da25bcd16ffec7434acd9ebdb4b293ee3d7cc184b0c");
    const [webhookPayload, setWebhookPayload] = useState(() =>
        JSON.stringify({ id: `evt_${Date.now()}`, source: "local.test", kind: "ping", value: 1 }, null, 2)
    );
    const [webhookResult, setWebhookResult] = useState<string>("");

    const signHmacSha256Hex = async (secret: string, body: string) => {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
            "raw",
            enc.encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );
        const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
        const bytes = new Uint8Array(sigBuf);
        return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
    };

    const sendWebhook = async () => {
        try {
            const body = webhookPayload;
            const sig = await signHmacSha256Hex(webhookSecret, body);

            const r = await fetch("/realtime/webhook", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-signature": sig
                },
                body
            });

            if (r.status === 429) {
                const retryAfter = Number(r.headers.get("Retry-After") || "1");
                setWebhookResult(`429 Rate limited. Retry after ~${retryAfter}s`);
                return;
            }

            const txt = await r.text();
            setWebhookResult(`${r.status} ${txt}`);
        } catch (e: any) {
            setWebhookResult(String(e));
        }
    };

    const [polling, setPolling] = useState(false);
    const [pollMode, setPollMode] = useState<"short" | "long">("long");
    const [pollAfterSeq, setPollAfterSeq] = useState<number | null>(null);
    const [pollRequests, setPollRequests] = useState(0);
    const [pollLastMs, setPollLastMs] = useState<number | null>(null);
    const [pollAvgMs, setPollAvgMs] = useState<number | null>(null);
    const [pollRps, setPollRps] = useState<number>(0);
    const [pollCatchUp, setPollCatchUp] = useState(false);
    const [pollLatencySeries, setPollLatencySeries] = useState<number[]>([]);
    const [pollStatus, setPollStatus] = useState<string>("");

    const pollAbortRef = useRef<AbortController | null>(null);
    const pollDurationsRef = useRef<number[]>([]);
    const pollTicksRef = useRef<number[]>([]); // timestamps of requests to compute RPS

    const startPolling = () => {
        if (polling) return;
        setPolling(true);

        const ac = new AbortController();
        pollAbortRef.current = ac;

        // use local cursor so it updates immediately (no stale React closure)
        let afterSeq = pollAfterSeq ?? 0;

        // reset metrics for a clean run
        pollDurationsRef.current = [];
        pollTicksRef.current = [];
        setPollLastMs(null);
        setPollAvgMs(null);
        setPollCatchUp(false);
        setPollRps(0);

        const run = async () => {
            while (!ac.signal.aborted) {
                try {
                    const timeoutMs = pollMode === "long" ? 25_000 : 0;

                    const qs = new URLSearchParams();
                    qs.set("afterSeq", String(afterSeq));
                    qs.set("timeoutMs", String(timeoutMs));

                    // metrics: tick + request count
                    pollTicksRef.current.push(performance.now());
                    setPollRequests((n) => n + 1);

                    // compute RPS over last 5 seconds immediately
                    const now = performance.now();
                    const windowMs = 5000;
                    pollTicksRef.current = pollTicksRef.current.filter(ts => now - ts <= windowMs);
                    setPollRps(pollTicksRef.current.length / (windowMs / 1000));


                    const t0 = performance.now();

                    const r = await fetch(`/realtime/poll?${qs.toString()}`, {
                        method: "GET",
                        signal: ac.signal
                    });

                    if (r.status === 429) {
                        const retryAfter = Number(r.headers.get("Retry-After") || "1");
                        // show status somewhere (add state below)
                        setPollStatus(`Rate limited (429). Retry after ~${retryAfter}s`);
                        await new Promise((r) => setTimeout(r, retryAfter * 1000));
                        continue;
                    }

                    const t1 = performance.now();
                    const dur = Math.max(0, t1 - t0);

                    setPollLatencySeries((prev) => {
                        const next = [...prev, dur];
                        return next.length > 30 ? next.slice(next.length - 30) : next;
                    });

                    // metrics: last + moving average (last 20)
                    pollDurationsRef.current.push(dur);
                    if (pollDurationsRef.current.length > 20) pollDurationsRef.current.shift();

                    setPollLastMs(dur);
                    const avg =
                        pollDurationsRef.current.reduce((a, b) => a + b, 0) / pollDurationsRef.current.length;
                    setPollAvgMs(avg);

                    const json = await r.json();
                    const events = Array.isArray(json.events) ? json.events : [];

                    // catch-up indicator: if server is returning events, we're catching up / receiving activity
                    setPollCatchUp(events.length > 0);

                    for (const evt of events) {
                        appendFeed({ seq: evt.seq, type: evt.type, ts: evt.ts, data: evt.data });
                    }

                    // update cursor (local + state)
                    if (json.cursor != null) {
                        const next = Number(json.cursor);
                        if (Number.isFinite(next) && next >= afterSeq) {
                            afterSeq = next;
                            setPollAfterSeq(next);
                        }
                    }

                    // Short poll: sleep to avoid hammering
                    if (pollMode === "short") {
                        await new Promise((r) => setTimeout(r, 500));
                    }

                    // Long poll should usually wait. If it returns instantly w/ no events (misconfig / edge),
                    // yield a tiny delay to avoid a busy loop.
                    if (pollMode === "long" && events.length === 0 && dur < 50) {
                        await new Promise((r) => setTimeout(r, 100));
                    }
                    setPollStatus("");
                } catch (e: any) {
                    if (ac.signal.aborted) break;
                    // backoff on errors
                    await new Promise((r) => setTimeout(r, 500));
                }
            }
        };

        run();
    };

    const stopPolling = () => {
        pollAbortRef.current?.abort();
        pollAbortRef.current = null;
        setPolling(false);
        setPollCatchUp(false);
    };

    function Sparkline({ values, width = 140, height = 26 }: { values: number[]; width?: number; height?: number }) {
        if (!values.length) {
            return <svg width={width} height={height} style={{ opacity: 0.6 }} />;
        }

        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = Math.max(1, max - min);

        const pad = 2;
        const w = width - pad * 2;
        const h = height - pad * 2;

        const pts = values.map((v, i) => {
            const x = pad + (i / Math.max(1, values.length - 1)) * w;
            const y = pad + (1 - (v - min) / range) * h;
            return { x, y };
        });

        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

        return (
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
                <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
        );
    }

    const publishDemoEvent = async () => {
        await apiJson("/realtime/publish", {
            method: "POST",
            body: JSON.stringify({ type: "demo.event", data: { at: nowIso(), msg: "hello from UI" } })
        });
    };

    useEffect(() => {
        const t = setInterval(async () => {
            try {
                const r = await fetch("/realtime/sse/status");
                if (!r.ok) return;
                const json = await r.json();
                setSseStatus(Array.isArray(json.conns) ? json.conns : []);
            } catch {}
        }, 1000);

        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        // auto-connect SSE for convenience
        connectSse();
        return () => {
            disconnectSse();
            disconnectWs();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div style={{display: "grid", gap: 12}}>
            <div className="card">
                <h2>Real-Time Lab</h2>
                <div className="small">
                    SSE = server → browser stream. WS = bi-directional. Webhook = system → system delivery.
                </div>
                <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10}}>
                    <button onClick={publishDemoEvent}>Publish demo event</button>
                </div>
            </div>

            <div className="card">
                <h3>SSE</h3>
                <div className="small">
                    Status: <b>{sseConnected ? "connected" : "disconnected"}</b> • reconnects: <b>{sseReconnects}</b> •
                    last event id:{" "}
                    <b>{lastSeq ?? "—"}</b>
                </div>
                <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10}}>
                    <button onClick={connectSse}>Connect</button>
                    <button onClick={disconnectSse}>Disconnect</button>
                </div>
                <div className="small" style={{marginTop: 10, opacity: 0.85}}>
                    Expected: SSE auto-reconnects on disconnect. (True Last-Event-ID resume from browsers requires a
                    fetch-based SSE client; we’ll add later if needed.)
                </div>
                <InterviewNotes title="Interview notes — SSE">
                    <div>
                        SSE provides a <b>one-way server → client stream</b> over HTTP. It’s ideal for push updates
                        where the
                        client does not need to send frequent messages. This demo includes reconnect behavior and cursor
                        replay
                        via <code>Last-Event-ID</code>.
                    </div>

                    <div className="notes__section">
                        <b>Strengths</b>
                        <NotesList
                            items={[
                                "Low overhead and simple operationally",
                                "Built-in reconnect semantics",
                                "Great for dashboards and notifications",
                                "Often easier to scale than WebSockets"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>Limitations</b>
                        <NotesList
                            items={[
                                "One-way only (server → client)",
                                "Some proxies buffer or terminate long responses",
                                "Not ideal for high-frequency bidirectional traffic"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>Metrics that matter</b>
                        <NotesList items={["Connection count", "Event delivery latency", "Reconnect frequency"]}/>
                    </div>

                    <div className="notes__section">
                        <b>When I’d use this</b>
                        <NotesList
                            items={["Real-time dashboards", "Notification feeds", "Monitoring/observability streams"]}/>
                    </div>
                </InterviewNotes>
            </div>

            <div className="card">
                <h3>SSE Backpressure</h3>

                <div className="small" style={{opacity: 0.85}}>
                    This demonstrates server-side backpressure handling using <code>res.write()</code> return value
                    + <code>drain</code>.
                    When a client can’t keep up, events are queued (bounded) and flushed when the socket drains.
                </div>

                <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10}}>
                    <button onClick={() => spamSse(8, 200, 2)}>Spam SSE (200 × 8KB)</button>
                    <button onClick={() => spamSse(256, 50, 2)}>Spam SSE (50 × 256KB)</button>
                    <button onClick={() => spamSse(256, 150, 2)}>Spam SSE (150 × 256KB)</button>
                </div>

                <div className="small" style={{marginTop: 10}}>
                    <b>Connections:</b> {sseStatus.length}
                </div>

                <div style={{marginTop: 10, overflowX: "auto"}}>
                    <table className="table">
                        <thead>
                        <tr>
                            <th>id</th>
                            <th>age</th>
                            <th>blocked</th>
                            <th>queue</th>
                            <th>queued</th>
                            <th>dropped</th>
                            <th>sent</th>
                            <th>last drain</th>
                        </tr>
                        </thead>
                        <tbody>
                        {sseStatus.map((c) => (
                            <tr key={c.id}>
                                <td style={{fontFamily: "monospace"}}>{c.id.slice(0, 8)}</td>
                                <td>{Math.round(c.ageMs / 1000)}s</td>
                                <td>{c.blocked ? "yes" : "no"}</td>
                                <td>{c.queueLen}</td>
                                <td>{Math.round(c.queuedBytes / 1024)}KB</td>
                                <td>{c.dropped}</td>
                                <td>{c.sentEvents}</td>
                                <td>{c.lastDrainAt ? new Date(c.lastDrainAt).toLocaleTimeString() : "—"}</td>
                            </tr>
                        ))}
                        {sseStatus.length === 0 && (
                            <tr>
                                <td colSpan={8} style={{opacity: 0.7}}>
                                    No SSE connections. Connect SSE first, then spam events.
                                </td>
                            </tr>
                        )}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="card">
                <h3>WebSocket</h3>
                <div className="small">
                    Status: <b>{wsConnected ? "connected" : "disconnected"}</b> • client: <b>{wsClientId ?? "—"}</b>
                </div>

                <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10}}>
                    <button onClick={connectWs}>Connect</button>
                    <button onClick={disconnectWs}>Disconnect</button>
                </div>

                <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10}}>
                    <input value={wsRoom} onChange={e => setWsRoom(e.target.value)} placeholder="room"/>
                    <button onClick={joinRoom} disabled={!wsConnected}>Join room</button>
                </div>

                <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10}}>
                    <input value={wsText} onChange={e => setWsText(e.target.value)} placeholder="message"
                           style={{minWidth: 260}}/>
                    <button onClick={sendWs} disabled={!wsConnected}>Send</button>
                </div>

                <div className="small" style={{marginTop: 10, opacity: 0.85}}>
                    Expected: WS supports two-way messaging + rooms. Server uses ping/pong keepalive and drops messages
                    if a client buffers too much (backpressure safety).
                </div>
                <InterviewNotes title="Interview notes — WebSockets">
                    <div>
                        WebSockets provide <b>full-duplex, low-latency communication</b> over a persistent connection.
                        This demo
                        shows connection lifecycle, fan-out, and integration with a shared event stream.
                    </div>

                    <div className="notes__section">
                        <b>Strengths</b>
                        <NotesList
                            items={[
                                "Bidirectional communication",
                                "Very low latency",
                                "Best fit for interactive systems"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>Tradeoffs</b>
                        <NotesList
                            items={[
                                "Stateful connections (more complex than HTTP)",
                                "Requires heartbeats/cleanup",
                                "Scaling horizontally requires stickiness or pub/sub fan-out",
                                "Backpressure must be considered explicitly"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>What breaks at scale</b>
                        <NotesList
                            items={[
                                "Sticky sessions or shared pub/sub fan-out",
                                "Connection limits per node",
                                "Slow consumers can impact throughput if not handled"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>When I’d use this</b>
                        <NotesList items={["Chat", "Collaborative editing", "Live interactive apps"]}/>
                    </div>
                </InterviewNotes>
            </div>

            <div className="card">
                <h3>Polling (Short + Long)</h3>
                {pollStatus && (
                    <div className="small" style={{marginTop: 8, opacity: 0.9}}>
                        <b>Status:</b> {pollStatus}
                    </div>
                )}

                <div className="small">
                    <span className="badge">
                      Mode: {pollMode}
                    </span>
                    <span className="badge"> status: {polling ? "running" : "stopped"} </span>
                    <span className="badge"> requests: {pollRequests}</span>
                    <span className="badge"> cursor:{" "} {pollAfterSeq ?? "—"}</span>
                </div>


                <div className="small"
                     style={{marginTop: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap"}}>
                    <span>Latency: <b>{pollLastMs == null ? "—" : `${pollLastMs.toFixed(0)}ms`}</b></span>
                    <span>Avg(20): <b>{pollAvgMs == null ? "—" : `${pollAvgMs.toFixed(0)}ms`}</b></span>
                    <span>RPS(5s): <b>{pollRps.toFixed(2)}</b></span>
                    <span className={`badge ${pollCatchUp ? "" : "badge--muted"}`}>
                      Catch-up: {pollCatchUp ? "yes" : "no"}
                    </span>

                    <span style={{display: "inline-flex", alignItems: "center", gap: 6, opacity: 0.85}}>
                        <span>Latency</span>
                        <Sparkline values={pollLatencySeries}/>
                    </span>
                </div>

                <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10}}>
                    <button onClick={() => setPollMode("short")} disabled={polling && pollMode === "short"}>
                        Short poll
                    </button>
                    <button onClick={() => setPollMode("long")} disabled={polling && pollMode === "long"}>
                        Long poll
                    </button>

                    <button onClick={startPolling} disabled={polling}>Start</button>
                    <button onClick={stopPolling} disabled={!polling}>Stop</button>

                    <button onClick={() => {
                        setPollAfterSeq(null);
                    }}>
                        Reset cursor
                    </button>
                </div>

                <div className="small" style={{marginTop: 10, opacity: 0.85}}>
                    Expected:
                    <ul>
                        <li><b>Short polling</b>: higher request volume, simpler, latency bounded by interval.</li>
                        <li><b>Long polling</b>: server holds request until an event arrives or timeout, lower churn,
                            near-real-time.
                        </li>
                    </ul>
                </div>

                <InterviewNotes title="Interview notes — Polling (Short + Long)">
                    <div>
                        Polling is the most compatible real-time delivery strategy because it works everywhere HTTP
                        works.
                        This lab uses <b>cursor-based polling</b> with a <b>monotonically increasing sequence</b> to
                        guarantee
                        ordering and avoid missed/duplicated events.
                    </div>

                    <div className="notes__section">
                        <b>Short polling</b>
                        <NotesList
                            items={[
                                "Client polls on a fixed interval",
                                "Simple to implement",
                                "Higher request volume when idle",
                                "Latency bounded by polling interval"
                            ]}
                        />
                        <b>Long polling</b>
                        <NotesList
                            items={[
                                "Server holds the request open until an event arrives or a timeout occurs",
                                "Near-real-time without persistent connections",
                                "Lower request churn than short polling",
                                "Timeout + reconnect behavior must be handled carefully"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>What to watch</b>
                        <NotesList
                            items={["RPS (request churn)", "Poll latency (idle vs active)", "Catch-up behavior after reconnects"]}/>
                    </div>

                    <div className="notes__section">
                        <b>Common failure modes</b>
                        <NotesList
                            items={[
                                "Tight polling loops due to stale cursors",
                                "Thundering herd after reconnect",
                                "Missing events without cursor semantics"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>When I’d use this</b>
                        <NotesList
                            items={[
                                "Fallback when SSE/WebSockets aren’t available",
                                "Constrained environments (proxies/firewalls)",
                                "When reliability matters more than lowest latency"
                            ]}
                        />
                    </div>
                </InterviewNotes>
            </div>

            <div className="card">
                <h3>Webhook Tester</h3>
                <div className="small" style={{opacity: 0.9}}>
                    Sends a signed webhook to <code>/realtime/webhook</code>. The backend verifies HMAC and dedupes by
                    event ID (SQLite).
                </div>

                <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10}}>
                    <input value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)}
                           style={{minWidth: 260}}/>
                    <button onClick={() => {
                        const id = `evt_${Date.now()}`;
                        setWebhookId(id);
                        setWebhookPayload(JSON.stringify({
                            id,
                            source: "local.test",
                            kind: "ping",
                            value: Math.floor(Math.random() * 100)
                        }, null, 2));
                    }}>
                        New payload
                    </button>
                    <button onClick={sendWebhook}>Send webhook</button>
                </div>

                <textarea
                    value={webhookPayload}
                    onChange={e => setWebhookPayload(e.target.value)}
                    rows={6}
                    style={{width: "100%", marginTop: 10, fontFamily: "monospace"}}
                />

                <div className="small" style={{marginTop: 10}}>
                    Result: <b>{webhookResult || "—"}</b>
                </div>

                <div className="small" style={{marginTop: 10, opacity: 0.85}}>
                    Expected: First send inserts into SQLite + publishes <code>webhook.received</code>. Re-sending the
                    same event ID returns OK with <code>duplicate: true</code>.
                </div>
                <InterviewNotes title="Interview notes — Webhooks">
                    <div>
                        Webhooks deliver events <b>across trust boundaries</b> and must be designed for failure. This
                        demo includes
                        signature verification over <b>raw bytes</b> and idempotent processing in SQLite.
                    </div>

                    <div className="notes__section">
                        <b>Key guarantees</b>
                        <NotesList
                            items={[
                                "At-least-once delivery",
                                "No ordering guarantee",
                                "Duplicate delivery is expected"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>Critical requirements</b>
                        <NotesList
                            items={[
                                "HMAC signature verification using raw request body",
                                "Idempotency key (unique event id) to dedupe",
                                "Retry-safe handler (no side effects on duplicates)"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>Common pitfalls</b>
                        <NotesList
                            items={[
                                "Parsing JSON before signature verification (consumes stream / changes bytes)",
                                "Assuming single delivery",
                                "Treating duplicates as errors instead of normal"
                            ]}
                        />
                    </div>

                    <div className="notes__section">
                        <b>When I’d use this</b>
                        <NotesList
                            items={["Third-party integrations", "Event-driven workflows", "Cross-service notifications"]}/>
                    </div>
                </InterviewNotes>
            </div>

            <div className="card eventFeed">
                <h3>Event Feed</h3>
                <div className="small" style={{opacity: 0.9}}>
                    Latest 200 events (from SSE + WS broadcast + polling + webhook events).
                </div>
                <div className="eventFeed__list">
                    {feed.map((e) => (
                        <div key={e.seq} className="eventFeed__item">
                            <div className="eventFeed__meta">
                                <b>{e.type}</b> • {new Date(e.ts).toLocaleTimeString()} • <span
                                style={{opacity: 0.7}}>seq={e.seq}</span>
                            </div>
                            <pre className="eventFeed__payload">
                                {JSON.stringify(e.data, null, 2)}
                            </pre>
                        </div>
                    ))}
                </div>
                <InterviewNotes title="Interview notes — Shared stream + monotonic cursor">
                    <div>
                        All delivery mechanisms in this lab share a single ordered stream using a <b>monotonic
                        sequence</b> cursor.
                        This enables deterministic ordering, cursor-based replay, and transport-agnostic dedupe.
                    </div>

                    <div className="notes__section">
                        <b>Why sequence beats timestamps/UUIDs</b>
                        <NotesList
                            items={[
                                "No clock skew",
                                "Simple numeric comparison",
                                "Easy gap detection (future descrambler)",
                                "Efficient replay semantics"
                            ]}
                        />
                    </div>
                </InterviewNotes>
            </div>
        </div>
    );
}
