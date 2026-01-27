import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db: Database<sqlite3.Database, sqlite3.Statement> | null = null;

export type FileRow = {
    id: string;
    name: string;
    total_bytes: number;
    created_at: string;
};

export async function getDb() {
    if (db) return db;

    const dbPath = path.join(__dirname, "..", "lab.sqlite");
    db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    // Good defaults for dev + concurrency
    await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

    await db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS file_chunks (
      file_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (file_id, idx),
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_file_chunks_file_id ON file_chunks(file_id);
  `);

    return db;
}

export function makeId(prefix = "f") {
    // Simple deterministic-ish id good enough for lab
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
