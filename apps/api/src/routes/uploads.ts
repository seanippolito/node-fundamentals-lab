import { Router } from "express";
import { z } from "zod";
import { getDb, makeId } from "../db.js";

export const uploadsRouter = Router();

const CHUNK_SIZE = 64 * 1024;

async function insertChunksBuffered(fileId: string, name: string, buf: Buffer) {
    const db = await getDb();
    await db.exec("BEGIN");
    try {
        await db.run(`INSERT INTO files (id, name, total_bytes) VALUES (?, ?, ?)`, [
            fileId,
            name,
            buf.length
        ]);

        const insertChunk = await db.prepare(
            `INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)`
        );

        let idx = 0;
        for (let offset = 0; offset < buf.length; offset += CHUNK_SIZE) {
            const chunk = buf.subarray(offset, Math.min(buf.length, offset + CHUNK_SIZE));
            await insertChunk.run(fileId, idx, chunk);
            idx++;
        }

        await insertChunk.finalize();
        await db.exec("COMMIT");
    } catch (e) {
        await db.exec("ROLLBACK");
        throw e;
    }
}

uploadsRouter.post("/memory", async (req, res, next) => {
    try {
        const schema = z.object({
            name: z.string().optional()
        });
        const { name } = schema.parse(req.query);

        // BAD: buffer entire request body in memory
        const chunks: Buffer[] = [];
        let total = 0;

        for await (const chunk of req) {
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            chunks.push(b);
            total += b.length;

            // Simple safety limit for the lab (tweak/remove for experiments)
            if (total > 200 * 1024 * 1024) {
                return res.status(413).json({ error: "payload too large for /upload/memory demo" });
            }
        }

        const buf = Buffer.concat(chunks);
        const fileId = makeId("up_mem");
        const filename = name ?? `upload_memory_${buf.length}.bin`;

        await insertChunksBuffered(fileId, filename, buf);

        res.json({ id: fileId, bytes: buf.length });
    } catch (err) {
        next(err);
    }
});

uploadsRouter.post("/stream", async (req, res, next) => {
    try {
        const schema = z.object({
            name: z.string().optional()
        });
        const { name } = schema.parse(req.query);

        const db = await getDb();
        const fileId = makeId("up_stream");
        const filename = name ?? `upload_stream_${Date.now()}.bin`;

        // GOOD: insert chunk-by-chunk as the request streams in
        await db.exec("BEGIN");
        try {
            await db.run(`INSERT INTO files (id, name, total_bytes) VALUES (?, ?, ?)`, [
                fileId,
                filename,
                0
            ]);

            const insertChunk = await db.prepare(
                `INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)`
            );

            let idx = 0;
            let totalBytes = 0;

            for await (const chunk of req) {
                const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += b.length;
                await insertChunk.run(fileId, idx, b);
                idx++;
            }

            await insertChunk.finalize();

            await db.run(`UPDATE files SET total_bytes = ? WHERE id = ?`, [totalBytes, fileId]);
            await db.exec("COMMIT");

            res.json({ id: fileId, bytes: totalBytes });
        } catch (e) {
            await db.exec("ROLLBACK");
            throw e;
        }
    } catch (err) {
        next(err);
    }
});
