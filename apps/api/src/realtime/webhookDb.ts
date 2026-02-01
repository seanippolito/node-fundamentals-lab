import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import path from "node:path";

let db: Database<sqlite3.Database, sqlite3.Statement> | null = null;

export async function getWebhookDb() {
    if (db) return db;

    const dbPath = path.join(process.cwd(), "realtime.webhooks.sqlite");

    db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    await db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      source TEXT,
      payload_json TEXT NOT NULL
    );
  `);

    return db;
}

export async function recordWebhookOnce(args: {
    id: string;
    source?: string;
    payload: any;
}): Promise<{ inserted: boolean }> {
    const db = await getWebhookDb();

    try {
        await db.run(
            `INSERT INTO webhook_events (id, received_at, source, payload_json)
            VALUES (?, ?, ?, ?)`,
            args.id,
            Date.now(),
            args.source ?? null,
            JSON.stringify(args.payload ?? {})
        );

        return { inserted: true };
    } catch (e: any) {
        // UNIQUE constraint violation → duplicate webhook
        if (String(e?.message || "").toLowerCase().includes("unique")) {
            return { inserted: false };
        }
        throw e;
    }
}
