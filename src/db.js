// SQLite 持久化层（Node 24 内置 node:sqlite，零外部依赖）
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { parseJsonArray, parseJsonObject } from './util.js';

let dbInstance = null;

export function openDb(dbPath = process.env.ALERT_DB || path.join('data', 'alert-center.db')) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  dbInstance = db;
  return db;
}

export function getDb() {
  if (!dbInstance) throw new Error('数据库尚未初始化');
  return dbInstance;
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// node:sqlite 没有 better-sqlite3 的 transaction() 助手，自行封装
export function transaction(fn) {
  const db = getDb();
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn(...args);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

// node:sqlite 不允许绑定 undefined（better-sqlite3 会自动转 null），统一规范化
function normalizeParams(args) {
  return args.map((v) => (v === undefined ? null : v));
}

// 返回带 undefined→null 规范化的 statement
export function prepare(sql) {
  const stmt = getDb().prepare(sql);
  const run = stmt.run.bind(stmt);
  const get = stmt.get.bind(stmt);
  const all = stmt.all.bind(stmt);
  stmt.run = (...args) => run(...normalizeParams(args));
  stmt.get = (...args) => get(...normalizeParams(args));
  stmt.all = (...args) => all(...normalizeParams(args));
  return stmt;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    match_json TEXT NOT NULL DEFAULT '[]',
    merge_key_template TEXT NOT NULL,
    parent_key_template TEXT,
    escalations_json TEXT NOT NULL DEFAULT '[]',
    current_version INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rule_versions (
    rule_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    match_json TEXT NOT NULL,
    merge_key_template TEXT NOT NULL,
    parent_key_template TEXT,
    escalations_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (rule_id, version)
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL,
    event_time TEXT NOT NULL,
    received_at TEXT NOT NULL,
    callback_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    rule_id TEXT,
    rule_version INTEGER,
    alert_id TEXT,
    out_of_order INTEGER NOT NULL DEFAULT 0,
    duplicate INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_events_alert ON events(alert_id);
  CREATE INDEX IF NOT EXISTS idx_events_rule_ver ON events(rule_id, rule_version);
  CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_time);

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    merge_key TEXT NOT NULL,
    parent_key TEXT,
    parent_id TEXT,
    title TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    current_escalation INTEGER NOT NULL DEFAULT 0,
    dedupe_count INTEGER NOT NULL DEFAULT 1,
    first_event_time TEXT NOT NULL,
    last_event_time TEXT NOT NULL,
    first_received_at TEXT NOT NULL,
    last_received_at TEXT NOT NULL,
    resolved_at TEXT,
    closed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
  CREATE INDEX IF NOT EXISTS idx_alerts_parent ON alerts(parent_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_parent_key ON alerts(parent_key);
  CREATE INDEX IF NOT EXISTS idx_alerts_merge ON alerts(merge_key, rule_version);

  CREATE TABLE IF NOT EXISTS alert_timeline (
    id TEXT PRIMARY KEY,
    alert_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_time TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    event_id TEXT,
    from_value TEXT,
    to_value TEXT,
    actor TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_alert ON alert_timeline(alert_id, event_time, recorded_at);

  -- 人工反馈只追加（append-only），任何自动流程都不会删除或覆盖
  CREATE TABLE IF NOT EXISTS alert_feedback (
    id TEXT PRIMARY KEY,
    alert_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    comment TEXT,
    operator TEXT NOT NULL,
    event_time TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_alert ON alert_feedback(alert_id, recorded_at);
  `);
}

// ---- 行映射：JSON 字段反序列化 ----
export function mapRule(r) {
  if (!r) return r;
  return {
    ...r,
    enabled: !!r.enabled,
    match: parseJsonArray(r.match_json),
    escalations: parseJsonArray(r.escalations_json),
  };
}

export function mapRuleVersion(v) {
  if (!v) return v;
  return {
    ...v,
    id: v.rule_id, // 快照与现行规则统一用 id 访问
    match: parseJsonArray(v.match_json),
    escalations: parseJsonArray(v.escalations_json),
  };
}

export function mapEvent(e) {
  if (!e) return e;
  return {
    ...e,
    payload: parseJsonObject(e.payload_json),
    out_of_order: !!e.out_of_order,
    duplicate: !!e.duplicate,
  };
}

