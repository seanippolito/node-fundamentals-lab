import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "../api"; // adjust path if your api helper lives elsewhere

type FeedEvent = {
    seq: number;
    type: string;
    ts: number;
    data: any;
};

function nowIso() {
    return new Date().toISOString().slice(11, 19);
}

export function RealtimeLab() {
    // ---- SSE
    const [sseConnected, setSseConnected] = useState(false);
    const [sseReconnects, setSseReconnects] = useState(0);
    const [lastSeq, setLastSeq] = useState<number | null>(null);
    const [feed, setFeed] = useState<FeedEvent[]>([]);
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

        // EventSource cannot set headers (so Last-Event-ID header won’t be sent automatically).
        // For this lab, we rely on server-side replay only when Last-Event-ID header exists.
        // If you want true resume in browser, we can switch SSE to fetch+ReadableStream later.
        const es = new EventSource("/realtime/sse");
        esRef.current = es;

        es.onopen = () => setSseConnected(true);

        es.onerror = () => {
            setSseConnected(false);
            setSseReconnects(n => n + 1);
        };

        // Listen to all events by using 'message' fallback plus explicit types
        es.onmessage = (m) => {
            try {
                const parsed = JSON.parse(m.data);
                appendFeed({ seq: Number(parsed.seq), type: parsed.type ?? "message", ts: parsed.ts, data: parsed.data });
            } catch {}
        };

        const known = ["webhook.received", "ws.connected", "ws.disconnected", "ws.joined", "ws.message", "demo.event"];
        known.forEach((t) => {
            es.addEventListener(t, (m: any) => {
                try {
                    const parsed = JSON.parse(m.data);
                    appendFeed({ seq: Number(parsed.seq), type: parsed.type ?? "message", ts: parsed.ts, data: parsed.data });
                } catch {}
            });
        });
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
                        await new Promise((r) => setTimeout(r, 1000));
                    }

                    // Long poll should usually wait. If it returns instantly w/ no events (misconfig / edge),
                    // yield a tiny delay to avoid a busy loop.
                    if (pollMode === "long" && events.length === 0 && dur < 50) {
                        await new Promise((r) => setTimeout(r, 100));
                    }
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
            </div>

            <div className="card">
                <h3>Polling (Short + Long)</h3>

                <div className="small">
                    Mode: <b>{pollMode}</b> • status: <b>{polling ? "running" : "stopped"}</b> •
                    requests: <b>{pollRequests}</b> • cursor:{" "}
                    <b>{pollAfterSeq ?? "—"}</b>
                </div>


                <div className="small"
                     style={{marginTop: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap"}}>
                    <span>Latency: <b>{pollLastMs == null ? "—" : `${pollLastMs.toFixed(0)}ms`}</b></span>
                    <span>Avg(20): <b>{pollAvgMs == null ? "—" : `${pollAvgMs.toFixed(0)}ms`}</b></span>
                    <span>RPS(5s): <b>{pollRps.toFixed(2)}</b></span>
                    <span
                        style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            border: "1px solid currentColor",
                            opacity: pollCatchUp ? 1 : 0.6
                        }}
                    >
                        Catch-up: <b>{pollCatchUp ? "yes" : "no"}</b>
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
            </div>

            <div className="card">
                <h3>Event Feed</h3>
                <div className="small" style={{opacity: 0.9}}>
                    Latest 200 events (from SSE + WS broadcast + webhook events).
                </div>
                <div style={{marginTop: 10, maxHeight: 360, overflow: "auto"}}>
                    {feed.map((e) => (
                        <div key={e.seq} style={{padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.06)"}}>
                            <div className="small">
                                <b>{e.type}</b> • {new Date(e.ts).toLocaleTimeString()} • <span
                                style={{opacity: 0.7}}>seq={e.seq}</span>
                            </div>
                            <pre className="small" style={{margin: 0, opacity: 0.9, whiteSpace: "pre-wrap"}}>
                {JSON.stringify(e.data, null, 2)}
              </pre>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
