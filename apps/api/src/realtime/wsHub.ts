import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { eventBus } from "./eventBus.js";

type Client = {
    ws: WebSocket;
    id: string;
    room: string;
    alive: boolean;
};

type WsClientMsg =
    | { type: "join"; room: string }
    | { type: "say"; room?: string; text: string };

function safeJsonParse(s: string): any {
    try { return JSON.parse(s); } catch { return null; }
}

export function attachWebSocketServer(server: any) {
    const wss = new WebSocketServer({ server, path: "/realtime/ws" });

    const clients = new Set<Client>();

    function broadcast(room: string, payload: any) {
        const msg = JSON.stringify(payload);
        for (const c of clients) {
            if (c.room !== room) continue;
            // Backpressure hint: if bufferedAmount is huge, drop (for demo safety)
            if (c.ws.readyState !== WebSocket.OPEN) continue;
            if (c.ws.bufferedAmount > 2 * 1024 * 1024) continue; // 2MB
            c.ws.send(msg);
        }
    }

    // Ping/pong keepalive (and basic liveness)
    const pingInterval = setInterval(() => {
        for (const c of clients) {
            if (!c.alive) {
                try { c.ws.terminate(); } catch {}
                clients.delete(c);
                continue;
            }
            c.alive = false;
            try { c.ws.ping(); } catch {}
        }
    }, 20_000);

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const client: Client = { ws, id, room: "lobby", alive: true };
        clients.add(client);

        // publish connect event (visible in SSE)
        eventBus.publish("ws.connected", { clientId: id, ip: req.socket.remoteAddress });

        ws.on("pong", () => { client.alive = true; });

        ws.on("message", (raw) => {
            const msg = safeJsonParse(raw.toString()) as WsClientMsg | null;
            if (!msg || typeof msg.type !== "string") return;

            if (msg.type === "join") {
                const room = (msg as any).room;
                if (typeof room === "string" && room.length <= 64) {
                    const prev = client.room;
                    client.room = room;
                    ws.send(JSON.stringify({ type: "joined", room }));
                    eventBus.publish("ws.joined", { clientId: id, from: prev, to: room, at: Date.now() });
                }
                return;
            }

            if (msg.type === "say") {
                const text = (msg as any).text;
                const room = typeof (msg as any).room === "string" ? (msg as any).room : client.room;
                if (typeof text !== "string" || text.length > 2000) return;

                const evt = eventBus.publish("ws.message", { clientId: id, room, text }, { room });
                broadcast(room, { type: "msg", seq: evt.seq, room, from: id, text, ts: evt.ts });
                return;
            }
        });

        ws.on("close", () => {
            clients.delete(client);
            eventBus.publish("ws.disconnected", { clientId: id });
        });

        ws.send(JSON.stringify({ type: "hello", clientId: id, room: client.room }));
    });

    wss.on("close", () => clearInterval(pingInterval));

    return { wss, clients };
}
