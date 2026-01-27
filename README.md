# Node Fundamentals Lab — Senior Backend Interview Prep

This project is a **hands-on laboratory for understanding Node.js backend fundamentals at a senior level**.

Instead of memorizing interview answers, this repo provides **real, observable behavior** for:

- memory usage (heap vs RSS)
- buffering vs streaming
- garbage collection
- memory leaks vs retention
- CPU blocking
- event loop behavior
- worker threads
- worker pools and CPU backpressure

The goal is to be able to **explain why Node behaves the way it does**, not just what the APIs do.

---

## 🎯 Why this project exists

Most Node interviews ask questions like:

- Why does Node crash even when heap looks fine?
- What’s the difference between buffering and streaming?
- What is RSS?
- What blocks the event loop?
- When should worker threads be used?
- Why does latency spike under load?
- How do you protect Node from CPU-heavy workloads?

This project lets you **see those answers in real time**.

---

## 🧠 Core Concepts Covered

### Memory
- JavaScript heap (`heapUsed`)
- Native memory (`external`)
- Process memory (`rss`)
- Garbage collection behavior
- Memory retention vs memory leaks

### IO
- Buffered file upload/download
- Streaming upload/download
- Backpressure (`res.write()` + `drain`)
- Effect of large buffers on memory and CPU

### CPU
- Event loop blocking
- Event loop delay (`monitorEventLoopDelay`)
- Worker threads
- Worker pool design
- CPU backpressure and saturation

---

## 🧱 Project Structure

```

apps/
api/            # Express + TypeScript backend
src/
routes/
files.ts   # buffer vs streaming IO
cpu.ts     # CPU block, worker, pool
workers/
cpuWorker.ts
cpuPool/
pool.ts    # worker pool implementation
metrics.ts   # memory + event loop metrics
web/             # React + Vite UI

````

---

## 🚀 Running the project

From the repo root:

```bash
pnpm install
pnpm dev
````

* API: [http://localhost:4000](http://localhost:4000)
* Web UI: [http://localhost:5173](http://localhost:5173)

---

## 🔍 Metrics exposed

The backend exposes live metrics:

### `/metrics/snapshot`

Current point-in-time metrics:

* heapUsed
* heapTotal
* rss
* external
* event loop delay (min/max/mean/p99)

### `/metrics/history`

Time-series data used for graphs:

* memory trends
* GC behavior
* event loop stalls

---

## 🧪 Labs Overview

---

## 1️⃣ Buffer vs Streaming IO

### Buffered download

* Entire payload loaded into memory
* Uses `Buffer.concat`
* Large native allocations
* CPU copy cost on event loop
* RSS spikes
* Event loop delay spikes

### Streaming download

* Small chunks
* Respects backpressure
* Bounded memory usage
* Minimal CPU stalls
* Much flatter RSS and event loop metrics

### Interview takeaway

> Buffering increases memory and CPU pressure. Streaming spreads work across many event loop turns and keeps the server responsive.

---

## 2️⃣ Memory Model (Critical Interview Topic)

Node memory consists of:

```
RSS (total process memory)
 ├─ V8 Heap (JavaScript objects)
 ├─ Native memory (Buffers, streams, sockets)
 └─ OS allocations
```

### Key insight

**Most Node memory problems are not heap problems.**

Buffers live **outside the JS heap**.

You can have:

* stable heap
* growing RSS
* process OOM

This is extremely common in production.

---

## 3️⃣ Garbage Collection (GC)

Observed behavior:

* heapUsed increases gradually
* sudden drops occur
* sawtooth pattern

This is **normal GC behavior**, not a leak.

### Interview explanation

> V8 allows heap to grow for allocation efficiency, then periodically runs GC which reclaims unreachable objects. Sudden drops in heapUsed are expected.

---

## 4️⃣ Memory Leak vs Memory Retention

### Memory Leak

* References are retained
* GC cannot reclaim memory
* heapUsed baseline continuously increases

Examples:

* global arrays
* unbounded caches
* forgotten event listeners

### Memory Retention

* Memory freed logically
* allocator does not return memory to OS
* RSS remains elevated

Common causes:

* large buffers
* streaming IO
* compression
* crypto
* sqlite/native libs

### Senior rule of thumb

> If heap keeps growing → leak
> If heap stabilizes but RSS stays high → retention

---

## 5️⃣ Event Loop

Node runs JavaScript on a **single main thread**.

That thread:

* executes route handlers
* processes callbacks
* handles timers
* coordinates IO

If it is blocked:

* all requests stall
* metrics stop responding
* health checks fail
* latency spikes

### Event loop delay metric

`monitorEventLoopDelay()` measures how late the loop is able to run scheduled work.

Large spikes indicate:

* CPU-bound JS
* large synchronous allocations
* GC pauses

---

## 6️⃣ CPU Blocking Lab

### `/cpu/block?ms=800`

* Busy loop runs on main thread
* Event loop blocked
* Event loop delay spikes
* Other requests stall

### Important observation

Even status endpoints cannot respond while the loop is blocked.

This explains why:

* metrics go dark during outages
* monitoring often fails first

---

## 7️⃣ Worker Threads

Worker threads:

* run in separate JS runtimes
* have their own event loop
* have their own heap
* communicate via messages

They are **explicit and opt-in**.

Node does NOT create JS threads automatically.

### Interview wording

✅ “Worker threads run JavaScript in parallel.”
❌ “Node creates threads per request.”

---

## 8️⃣ Worker Pool (Senior-Level Topic)

Spawning a worker per request is inefficient.

Instead we use:

* fixed-size pool
* FIFO queue
* max queue size
* rejection when saturated

This applies **backpressure to CPU**, just like streams apply backpressure to IO.

### Pool behavior

* `running` ≤ pool size
* `queued` grows under load
* once queue is full → requests rejected (HTTP 429)

### Interview insight

> CPU must be backpressured just like network IO.

This is a very strong senior-level concept.

---

## 🧠 How to explain this in interviews

### Event loop

> Node executes JavaScript on a single event-loop thread. CPU-heavy work blocks the loop and delays all other operations.

### Streaming

> Streaming reduces memory usage and CPU stalls by breaking work into small chunks and respecting backpressure.

### Memory

> Heap shows JS objects. RSS shows real memory pressure. Many Node OOMs happen due to native buffers, not heap leaks.

### Worker threads

> Workers are used for CPU-heavy tasks to keep the event loop responsive.

### Worker pools

> Workers should be pooled and backpressured to prevent CPU saturation.

---

## 🔑 Senior interview one-liners

You can safely memorize these:

* “Most Node memory issues come from native buffers, not the JS heap.”
* “If heap grows steadily, it’s likely a leak. If RSS stays high, it’s usually retention.”
* “Streaming is about memory safety and event loop responsiveness.”
* “CPU-heavy JavaScript blocks the entire server.”
* “Worker threads isolate CPU work but must be pooled.”
* “Backpressure applies to CPU just like it applies to IO.”

---

## ✅ Why this project matters

This repo demonstrates **behavior**, not theory.

Instead of saying:

> “I understand Node memory.”

You can say:

> “I built a lab that visualizes heap, RSS, GC, buffering, streaming, event loop delay, and CPU backpressure.”

That difference is enormous in senior interviews.

---

## 📌 Recommended interview flow

If asked a deep question:

1. Explain conceptually
2. Describe observed behavior
3. Tie it back to production impact
4. Mention mitigation strategies

This project supports all four.

---

## 🚧 Future extensions (optional)

* Redis-backed job queues
* BullMQ integration
* container memory limits
* autoscaling demonstrations
* CPU core–aware pool sizing

---

## 🧠 Final note

Node is not “slow”.
Node is **predictable** once you understand:

* memory boundaries
* event loop constraints
* backpressure
* CPU isolation

This project exists to make those boundaries visible.

```

---