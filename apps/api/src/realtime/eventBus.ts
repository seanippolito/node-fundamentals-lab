import { randomUUID } from "node:crypto";

export type RtEvent = {
    seq: number;     // monotonically increasing cursor
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
    private nextSeq = 1;

    constructor(maxEvents = 500) {
        this.maxEvents = maxEvents;
    }

    publish(type: string, data: any, opts?: { room?: string; seq?: number; ts?: number }): RtEvent {
        const seq = opts?.seq ?? this.nextSeq++;
        // Ensure monotonic even if seq is provided
        if (seq >= this.nextSeq) this.nextSeq = seq + 1;

        const evt: RtEvent = {
            seq,
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

    replayAfterSeq(afterSeq?: number, limit = 200): RtEvent[] {
        if (afterSeq == null || Number.isNaN(afterSeq)) return [];
        // ring is ordered by seq because we append in publish order
        const startIdx = this.ring.findIndex(e => e.seq > afterSeq);
        if (startIdx < 0) return [];
        return this.ring.slice(startIdx, startIdx + limit);
    }

    latestSeq(): number {
        const last = this.ring[this.ring.length - 1];
        return last?.seq ?? 0;
    }
}

// Single shared instance for the process
export const eventBus = new EventBus(1000);
