import { randomUUID } from "node:crypto";

export type RtEvent = {
    id: string;              // monotonic-ish string id
    type: string;            // e.g. "webhook.received", "ws.message", "demo.tick"
    ts: number;              // epoch ms
    data: any;               // payload
    room?: string;           // optional room
};

type Subscriber = (evt: RtEvent) => void;

export class EventBus {
    private subs = new Set<Subscriber>();
    private ring: RtEvent[] = [];
    private readonly maxEvents: number;

    constructor(maxEvents = 500) {
        this.maxEvents = maxEvents;
    }

    publish(type: string, data: any, opts?: { room?: string; id?: string; ts?: number }): RtEvent {
        const evt: RtEvent = {
            id: opts?.id ?? `${Date.now()}-${randomUUID()}`, // good enough for demo + ordering
            type,
            ts: opts?.ts ?? Date.now(),
            data,
            room: opts?.room
        };

        this.ring.push(evt);
        if (this.ring.length > this.maxEvents) this.ring.shift();

        for (const fn of this.subs) {
            try { fn(evt); } catch { /* ignore */ }
        }
        return evt;
    }

    subscribe(fn: Subscriber): () => void {
        this.subs.add(fn);
        return () => this.subs.delete(fn);
    }

    // Replay events after a given id (Last-Event-ID)
    replayAfter(lastEventId?: string, limit = 200): RtEvent[] {
        if (!lastEventId) return [];
        const idx = this.ring.findIndex(e => e.id === lastEventId);
        if (idx < 0) return [];
        return this.ring.slice(idx + 1, idx + 1 + limit);
    }
}

// Single shared instance for the process
export const eventBus = new EventBus(1000);
