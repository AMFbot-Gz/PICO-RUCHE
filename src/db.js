/**
 * db.js — Wrapper SQLite léger via sql.js (in-memory + persist sur disque)
 * Interface : initDb(schema) + run(sql, params)
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import initSqlJs from "sql.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "..", ".laruche");
const DB_PATH = join(DB_DIR, "pico_ruche.db");

let _db = null;

async function getDb() {
  if (_db) return _db;

  mkdirSync(DB_DIR, { recursive: true });

  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const data = readFileSync(DB_PATH);
    _db = new SQL.Database(data);
  } else {
    _db = new SQL.Database();
  }

  return _db;
}

function persist() {
  if (!_db) return;
  try {
    const data = _db.export();
    writeFileSync(DB_PATH, Buffer.from(data));
  } catch {}
}

export async function initDb(schema) {
  const db = await getDb();
  db.run(schema);
  persist();
}

export async function run(sql, params = []) {
  const db = await getDb();
  try {
    db.run(sql, params);
    persist();
    return { changes: 1 };
  } catch (e) {
    console.error("[DB] Error:", e.message, "| SQL:", sql);
    throw e;
  }
}

export async function query(sql, params = []) {
  const db = await getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Alias sémantiques — get() retourne la première ligne ou null, all() retourne tout
export async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

export async function all(sql, params = []) {
  return query(sql, params);
}
