import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "../api"; // adjust path if your api helper lives elsewhere

type FeedEvent = {
    id: string;
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
    const [lastEventId, setLastEventId] = useState<string | null>(null);
    const [feed, setFeed] = useState<FeedEvent[]>([]);
    const esRef = useRef<EventSource | null>(null);

    const appendFeed = (evt: FeedEvent) => {
        setFeed(prev => {
            const next = [evt, ...prev];
            return next.slice(0, 200);
        });
        setLastEventId(evt.id);
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
                appendFeed({ id: parsed.id, type: parsed.type ?? "message", ts: parsed.ts, data: parsed.data });
            } catch {}
        };

        const known = ["webhook.received", "ws.connected", "ws.disconnected", "ws.joined", "ws.message", "demo.event"];
        known.forEach((t) => {
            es.addEventListener(t, (m: any) => {
                try {
                    const parsed = JSON.parse(m.data);
                    appendFeed({ id: parsed.id, type: t, ts: parsed.ts, data: parsed.data });
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
                    appendFeed({ id: msg.eventId ?? `${Date.now()}`, type: "ws.broadcast", ts: Date.now(), data: msg });
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
            console.log("[webhook] client sig:", sig, "bodyLen:", body.length);

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
        <div style={{ display: "grid", gap: 12 }}>
            <div className="card">
                <h2>Real-Time Lab</h2>
                <div className="small">
                    SSE = server → browser stream. WS = bi-directional. Webhook = system → system delivery.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    <button onClick={publishDemoEvent}>Publish demo event</button>
                </div>
            </div>

            <div className="card">
                <h3>SSE</h3>
                <div className="small">
                    Status: <b>{sseConnected ? "connected" : "disconnected"}</b> • reconnects: <b>{sseReconnects}</b> • last event id:{" "}
                    <b>{lastEventId ?? "—"}</b>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    <button onClick={connectSse}>Connect</button>
                    <button onClick={disconnectSse}>Disconnect</button>
                </div>
                <div className="small" style={{ marginTop: 10, opacity: 0.85 }}>
                    Expected: SSE auto-reconnects on disconnect. (True Last-Event-ID resume from browsers requires a fetch-based SSE client; we’ll add later if needed.)
                </div>
            </div>

            <div className="card">
                <h3>WebSocket</h3>
                <div className="small">
                    Status: <b>{wsConnected ? "connected" : "disconnected"}</b> • client: <b>{wsClientId ?? "—"}</b>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    <button onClick={connectWs}>Connect</button>
                    <button onClick={disconnectWs}>Disconnect</button>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    <input value={wsRoom} onChange={e => setWsRoom(e.target.value)} placeholder="room" />
                    <button onClick={joinRoom} disabled={!wsConnected}>Join room</button>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    <input value={wsText} onChange={e => setWsText(e.target.value)} placeholder="message" style={{ minWidth: 260 }} />
                    <button onClick={sendWs} disabled={!wsConnected}>Send</button>
                </div>

                <div className="small" style={{ marginTop: 10, opacity: 0.85 }}>
                    Expected: WS supports two-way messaging + rooms. Server uses ping/pong keepalive and drops messages if a client buffers too much (backpressure safety).
                </div>
            </div>

            <div className="card">
                <h3>Webhook Tester</h3>
                <div className="small" style={{ opacity: 0.9 }}>
                    Sends a signed webhook to <code>/realtime/webhook</code>. The backend verifies HMAC and dedupes by event ID (SQLite).
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    <input value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} style={{ minWidth: 260 }} />
                    <button onClick={() => {
                        const id = `evt_${Date.now()}`;
                        setWebhookId(id);
                        setWebhookPayload(JSON.stringify({ id, source: "local.test", kind: "ping", value: Math.floor(Math.random() * 100) }, null, 2));
                    }}>
                        New payload
                    </button>
                    <button onClick={sendWebhook}>Send webhook</button>
                </div>

                <textarea
                    value={webhookPayload}
                    onChange={e => setWebhookPayload(e.target.value)}
                    rows={6}
                    style={{ width: "100%", marginTop: 10, fontFamily: "monospace" }}
                />

                <div className="small" style={{ marginTop: 10 }}>
                    Result: <b>{webhookResult || "—"}</b>
                </div>

                <div className="small" style={{ marginTop: 10, opacity: 0.85 }}>
                    Expected: First send inserts into SQLite + publishes <code>webhook.received</code>. Re-sending the same event ID returns OK with <code>duplicate: true</code>.
                </div>
            </div>

            <div className="card">
                <h3>Event Feed</h3>
                <div className="small" style={{ opacity: 0.9 }}>
                    Latest 200 events (from SSE + WS broadcast + webhook events).
                </div>
                <div style={{ marginTop: 10, maxHeight: 360, overflow: "auto" }}>
                    {feed.map((e) => (
                        <div key={e.id} style={{ padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                            <div className="small">
                                <b>{e.type}</b> • {new Date(e.ts).toLocaleTimeString()} • <span style={{ opacity: 0.7 }}>{e.id}</span>
                            </div>
                            <pre className="small" style={{ margin: 0, opacity: 0.9, whiteSpace: "pre-wrap" }}>
                {JSON.stringify(e.data, null, 2)}
              </pre>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
