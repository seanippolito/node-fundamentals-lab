import { Router } from "express";
import { z } from "zod";
import { getDb, makeId, type FileRow } from "../db.js";

export const filesRouter = Router();

const CHUNK_SIZE = 64 * 1024; // 64KB chunks (tweak for experiments)

function randomChunk(size: number) {
    // For lab purposes. crypto.randomBytes is fine too; this keeps it simple & fast.
    const buf = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) buf[i] = (Math.random() * 256) | 0;
    return buf;
}

filesRouter.get("/list", async (_req, res) => {
    const db = await getDb();
    const rows = await db.all<FileRow[]>(`SELECT * FROM files ORDER BY created_at DESC LIMIT 200`);
    res.json({ files: rows });
});

filesRouter.post("/generate", async (req, res, next) => {
    try {
        const schema = z.object({
            name: z.string().optional(),
            sizeMb: z.coerce.number().min(1).max(500).default(10)
        });
        const { name, sizeMb } = schema.parse(req.query);

        const db = await getDb();
        const fileId = makeId("file");
        const totalBytes = Math.floor(sizeMb * 1024 * 1024);

        await db.exec("BEGIN");
        try {
            await db.run(`INSERT INTO files (id, name, total_bytes) VALUES (?, ?, ?)`, [
                fileId,
                name ?? `generated_${sizeMb}MB.bin`,
                totalBytes
            ]);

            const insertChunk = await db.prepare(
                `INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)`
            );

            let remaining = totalBytes;
            let idx = 0;

            while (remaining > 0) {
                const size = Math.min(CHUNK_SIZE, remaining);
                const chunk = randomChunk(size);
                await insertChunk.run(fileId, idx, chunk);
                idx++;
                remaining -= size;
            }

            await insertChunk.finalize();
            await db.exec("COMMIT");
        } catch (e) {
            await db.exec("ROLLBACK");
            throw e;
        }

        res.json({ id: fileId, totalBytes });
    } catch (err) {
        next(err);
    }
});

filesRouter.get("/:id/meta", async (req, res) => {
    const db = await getDb();
    const row = await db.get<FileRow>(`SELECT * FROM files WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: "not found" });
    res.json({ file: row });
});

// BUFFERED download: loads all chunks into memory, then sends
filesRouter.get("/:id/buffer", async (req, res) => {
    const db = await getDb();
    const file = await db.get<FileRow>(`SELECT * FROM files WHERE id = ?`, [req.params.id]);
    if (!file) return res.status(404).json({ error: "not found" });

    const rows = await db.all<{ data: Buffer }[]>(
        `SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx ASC`,
        [file.id]
    );

    const buf = Buffer.concat(rows.map(r => r.data));

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.setHeader("Content-Length", String(buf.length));
    res.send(buf);
});

// STREAMING download: reads chunk rows in order and writes to response.
// Demonstrates backpressure via res.write() return value + drain.
filesRouter.get("/:id/stream", async (req, res) => {
    const db = await getDb();
    const file = await db.get<FileRow>(`SELECT * FROM files WHERE id = ?`, [req.params.id]);
    if (!file) return res.status(404).json({ error: "not found" });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.setHeader("Content-Length", String(file.total_bytes));

    // Fetch chunks one by one (or in small batches) to avoid huge memory.
    // SQLite row fetching is still “read into memory per row”, but bounded by chunk size.
    const chunkCountRow = await db.get<{ n: number }>(
        `SELECT COUNT(*) as n FROM file_chunks WHERE file_id = ?`,
        [file.id]
    );
    const n = chunkCountRow?.n ?? 0;

    for (let idx = 0; idx < n; idx++) {
        const row = await db.get<{ data: Buffer }>(
            `SELECT data FROM file_chunks WHERE file_id = ? AND idx = ?`,
            [file.id, idx]
        );
        if (!row) break;

        const ok = res.write(row.data);
        if (!ok) {
            await new Promise<void>(resolve => res.once("drain", resolve));
        }
    }

    res.end();
});

filesRouter.delete("/:id", async (req, res) => {
    const db = await getDb();
    const info = await db.run(`DELETE FROM files WHERE id = ?`, [req.params.id]);
    res.json({ deleted: info.changes ?? 0 });
});
