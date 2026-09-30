import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  due_date TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_sender TEXT,
  source_text TEXT,
  source_message_id TEXT UNIQUE,
  source_timestamp TEXT,
  recurrence TEXT,
  is_template INTEGER NOT NULL DEFAULT 0,
  template_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  occurrence_date TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  UNIQUE(template_id, occurrence_date)
);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(is_template, completed_at, start_date);
CREATE INDEX IF NOT EXISTS idx_tasks_template ON tasks(template_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS wa_messages (
  message_id TEXT PRIMARY KEY,
  chat_jid TEXT,
  sender TEXT,
  text TEXT,
  message_ts TEXT,
  task_id INTEGER,
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
  dismissed_at TEXT
);
`;

export function getDb() {
  if (!db) {
    db = new DatabaseSync(config.dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
  }
  return db;
}

/** Usado nos testes: abre um banco em memória isolado. */
export function useMemoryDb() {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- settings / state (chave-valor) ----------

export const DEFAULT_SETTINGS = {
  wa_group_jid: '',
  wa_marker: '#demanda',
  wa_reply_enabled: '1',
  wa_reply_text: '✅ Anotado: {titulo}',
  wa_accept_own: '1',
  wa_allowed_senders: '',
  wa_offline_alert_hours: '2',
};

export function getSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSettings(obj) {
  const stmt = getDb().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(obj)) {
    if (k in DEFAULT_SETTINGS) stmt.run(k, String(v ?? ''));
  }
  return getSettings();
}

export function getState(key) {
  const row = getDb().prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setState(key, value) {
  getDb().prepare('INSERT INTO state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? null : String(value));
}

// ---------- avisos ----------

export function addNotice(kind, message) {
  const r = getDb().prepare('INSERT INTO notices(kind, message) VALUES (?, ?)').run(kind, message);
  return Number(r.lastInsertRowid);
}

export function listNotices() {
  return getDb().prepare('SELECT * FROM notices WHERE dismissed_at IS NULL ORDER BY id DESC').all();
}

export function dismissNotice(id) {
  getDb().prepare('UPDATE notices SET dismissed_at = ? WHERE id = ?').run(nowIso(), id);
}
