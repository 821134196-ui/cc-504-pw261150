// 核心告警引擎：事件匹配 / 幂等去重 / 告警合并 / 父子关系 / 时间升级 / 人工反馈保护
import { getDb, transaction, prepare } from './db.js';
import {
  newId, nowIso, getPath, renderTemplate, HttpError, SEVERITY_ORDER,
} from './util.js';
import { findEnabledRules, getRuleVersion } from './rules.js';

const OPEN_STATUSES = new Set(['firing', 'acknowledged']);
// 视为"已闭环"的状态：自动关闭不会覆盖这些状态上的人工反馈
const CLOSED_STATUSES = new Set(['resolved', 'false_positive']);
const VALID_EVENT_STATUS = new Set(['firing', 'resolved']);

// 进程内 watermark（重启后从 events 表惰性重建）
const watermarks = new Map();

function watermarkFor(db, eventType) {
  if (!watermarks.has(eventType)) {
    const row = prepare('SELECT MAX(event_time) AS m FROM events WHERE event_type = ?').get(eventType);
    watermarks.set(eventType, row?.m ?? null);
  }
  return watermarks.get(eventType);
}

function bumpWatermark(eventType, eventTime) {
  const cur = watermarks.get(eventType);
  if (!cur || Date.parse(eventTime) > Date.parse(cur)) watermarks.set(eventType, eventTime);
}

// ---------- 规则匹配 ----------
function testOne(value, op, expected) {
  switch (op) {
    case 'eq': case undefined: return value === expected;
    case 'neq': return value !== expected;
    case 'gt': return Number(value) > Number(expected);
    case 'gte': return Number(value) >= Number(expected);
    case 'lt': return Number(value) < Number(expected);
    case 'lte': return Number(value) <= Number(expected);
    case 'in': return Array.isArray(expected) && expected.includes(value);
    case 'contains':
      return typeof value === 'string' ? value.includes(String(expected))
        : Array.isArray(value) && value.includes(expected);
    case 'exists': return (value !== undefined && value !== null) === !!expected;
    default: throw new HttpError(400, `不支持的匹配操作符：${op}`);
  }
}

export function ruleMatches(rule, event) {
  for (const pred of rule.match ?? []) {
    const value = getPath(event.payload, pred.path);
    if (!testOne(value, pred.op, pred.value)) return false;
  }
  return true;
}

// ---------- 时间线 ----------
function addTimeline(db, alertId, type, title, opts = {}) {
  prepare(`INSERT INTO alert_timeline
    (id, alert_id, event_type, event_time, recorded_at, title, detail, event_id, from_value, to_value, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId('tl'), alertId, type, opts.event_time ?? nowIso(), nowIso(), title,
    opts.detail ?? null, opts.event_id ?? null,
    opts.from ?? null, opts.to ?? null, opts.actor ?? null,
  );
}

// ---------- 父子关系 ----------
function findParent(db, parentKey, excludeId) {
  if (!parentKey) return null;
  // 父告警的 merge_key 等于子规则渲染出的 parent_key
  const rows = prepare(
    'SELECT * FROM alerts WHERE merge_key = ? AND id != ? ORDER BY created_at DESC',
  ).all(parentKey, excludeId);
  // 优先关联到仍处于打开状态的父告警
  return rows.find((r) => OPEN_STATUSES.has(r.status)) ?? rows[0] ?? null;
}

function linkChild(db, child, parent, eventTime) {
  prepare('UPDATE alerts SET parent_id = ?, updated_at = ? WHERE id = ?')
    .run(parent.id, nowIso(), child.id);
  addTimeline(db, child.id, 'linked', `挂载到父告警 ${parent.title}`, {
    event_time: eventTime, detail: `parent_id=${parent.id}`, to: parent.id,
  });
  addTimeline(db, parent.id, 'child_attached', `子告警接入：${child.title}`, {
    event_time: eventTime, detail: `child_id=${child.id}`, to: child.id,
  });
}

// 父告警在自身事件已修复且所有子告警均闭环时自动关闭（人工反馈状态不被覆盖）
function maybeAutoCloseParent(db, parentId, eventTime) {
  const parent = prepare('SELECT * FROM alerts WHERE id = ?').get(parentId);
  if (!parent || !OPEN_STATUSES.has(parent.status)) return;

  const openChildren = prepare(
    "SELECT COUNT(*) AS n FROM alerts WHERE parent_id = ? AND status IN ('firing','acknowledged')",
  ).get(parentId).n;
  if (openChildren > 0) return;

  // 父告警自身是否已收到修复事件（resolved 事件挂在父告警自身上）
  const ownRepaired = prepare(
    "SELECT 1 FROM events WHERE alert_id = ? AND rule_id = ? AND status = 'resolved' LIMIT 1",
  ).get(parentId, parent.rule_id);
  if (!ownRepaired) return;

  if (parent.status === 'acknowledged') {
    // 人工已确认：保留确认状态与反馈，仅追加时间线，不自动改状态
    addTimeline(db, parentId, 'auto_close_skipped',
      '所有子告警与事件均已修复，但该告警已被人工确认，保持当前状态', { event_time: eventTime });
    return;
  }
  resolveAlert(db, parent, eventTime, 'system', '父告警：子告警全部闭环且自身事件已修复');
}

// ---------- 状态流转 ----------
function resolveAlert(db, alert, eventTime, actor, detail) {
  const from = alert.status;
  prepare(`UPDATE alerts SET status = 'resolved', resolved_at = ?, closed_by = ?,
      updated_at = ? WHERE id = ?`).run(eventTime, actor, nowIso(), alert.id);
  addTimeline(db, alert.id, 'resolved', '告警自动关闭', {
    event_time: eventTime, from, to: 'resolved', actor, detail,
  });
}

function openAlertByMergeKey(db, ruleId, ruleVersion, mergeKey) {
  return prepare(
    "SELECT * FROM alerts WHERE rule_id = ? AND rule_version = ? AND merge_key = ? AND status IN ('firing','acknowledged') LIMIT 1",
  ).get(ruleId, ruleVersion, mergeKey);
}

function createAlert(db, { rule, event, mergeKey, parentKey, severity }) {
  const id = newId('al');
  const title = `${rule.name} · ${mergeKey}`;
  prepare(`INSERT INTO alerts
    (id, rule_id, rule_version, event_type, merge_key, parent_key, parent_id, title, severity,
     status, current_escalation, dedupe_count, first_event_time, last_event_time,
     first_received_at, last_received_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'firing', 0, 1, ?, ?, ?, ?, ?, ?)`).run(
    id, rule.id, rule.version, event.event_type, mergeKey, parentKey, title, severity,
    event.event_time, event.event_time, event.received_at, event.received_at,
    event.received_at, event.received_at,
  );
  const alert = prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  addTimeline(db, id, 'created', `告警创建：${title}`, {
    event_time: event.event_time, event_id: event.id, detail: `规则 ${rule.name} v${rule.version}`,
  });
  return alert;
}

function mergeIntoAlert(db, alert, event, isReopen) {
  const from = alert.status;
  const nextStatus = isReopen ? 'firing' : alert.status;
  prepare(`UPDATE alerts SET
      dedupe_count = dedupe_count + 1,
      first_event_time = MIN(first_event_time, ?),
      last_event_time = MAX(last_event_time, ?),
      last_received_at = ?,
      status = ?,
      resolved_at = CASE WHEN ? = 1 THEN NULL ELSE resolved_at END,
      closed_by = CASE WHEN ? = 1 THEN NULL ELSE closed_by END,
      updated_at = ?
    WHERE id = ?`).run(
    event.event_time, event.event_time, event.received_at, nextStatus,
    isReopen ? 1 : 0, isReopen ? 1 : 0, nowIso(), alert.id,
  );
  addTimeline(db, alert.id, isReopen ? 'reopened' : 'deduplicated',
    isReopen ? '同合并键再次触发，告警重新打开（历史反馈保留）' : `重复事件合并（第 ${alert.dedupe_count + 1} 次）`,
    { event_time: event.event_time, event_id: event.id, from: isReopen ? from : undefined, to: isReopen ? 'firing' : undefined },
  );
  return prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id);
}

// ---------- 事件入站 ----------
export function ingestEvent(body) {
  const db = getDb();
  if (!body || typeof body !== 'object') throw new HttpError(400, '请求体必须是对象');
  const { event_id, event_type, status, event_time, payload, callback_id } = body;
  if (!event_id || typeof event_id !== 'string') throw new HttpError(400, 'event_id 必填');
  if (!event_type || typeof event_type !== 'string') throw new HttpError(400, 'event_type 必填');
  if (!VALID_EVENT_STATUS.has(status)) throw new HttpError(400, "status 仅支持 'firing' | 'resolved'");
  if (!event_time || Number.isNaN(Date.parse(event_time))) throw new HttpError(400, 'event_time 必须是 ISO 时间');

  const receivedAt = nowIso();
  // 幂等键：显式 callback_id 优先；重复回调整个请求直接返回首次结果
  const idempotencyKey = callback_id
    ? `cb:${callback_id}`
    : `ev:${event_id}:${status}:${new Date(event_time).toISOString()}`;

  const result = { duplicate: false, out_of_order: false, alert: null, event: null, matched: false };

  const tx = transaction(() => {
    const existingIdem = prepare('SELECT * FROM events WHERE idempotency_key = ?').get(idempotencyKey);
    if (existingIdem) {
      // 完全重复的回调：原样返回，不产生任何副作用
      const ev = prepare('SELECT * FROM events WHERE id = ?').get(existingIdem.id);
      result.duplicate = true;
      result.event = ev;
      result.matched = !!ev.alert_id;
      result.alert = ev.alert_id ? prepare('SELECT * FROM alerts WHERE id = ?').get(ev.alert_id) : null;
      return;
    }

    const wm = watermarkFor(db, event_type);
    const outOfOrder = !!wm && Date.parse(event_time) < Date.parse(wm);

    // 同一 event_id 再次上报（不同状态/时间）：标记为重复事件，仍走处理管线
    const sameEventBefore = prepare('SELECT 1 FROM events WHERE event_id = ? LIMIT 1').get(event_id);
    const isRepeatEventId = !!sameEventBefore;

    const eventRow = {
      id: newId('ev'),
      event_id, event_type, status,
      event_time: new Date(event_time).toISOString(),
      received_at: receivedAt,
      callback_id: callback_id ?? null,
      idempotency_key: idempotencyKey,
      payload_json: JSON.stringify(payload ?? {}),
      out_of_order: outOfOrder ? 1 : 0,
      duplicate: isRepeatEventId ? 1 : 0,
    };
    prepare(`INSERT INTO events
      (id, event_id, event_type, status, event_time, received_at, callback_id, idempotency_key,
       payload_json, rule_id, rule_version, alert_id, out_of_order, duplicate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`).run(
      eventRow.id, eventRow.event_id, eventRow.event_type, eventRow.status, eventRow.event_time,
      eventRow.received_at, eventRow.callback_id, eventRow.idempotency_key, eventRow.payload_json,
      eventRow.out_of_order, eventRow.duplicate,
    );
    bumpWatermark(event_type, eventRow.event_time);
    result.out_of_order = outOfOrder;
    result.duplicate = isRepeatEventId;

    const event = {
      id: eventRow.id, event_id, event_type, status,
      event_time: eventRow.event_time, received_at: receivedAt,
      payload: payload ?? {}, out_of_order: outOfOrder, duplicate: isRepeatEventId,
    };

    // 规则匹配：只使用"当前版本"，规则后续变更不影响存量告警
    const rule = findEnabledRules(event_type).find((r) => ruleMatches(r, event));
    if (!rule) {
      // 未命中规则的事件不产生告警，仅落事件表，可在事件流页检索
      result.event = prepare('SELECT * FROM events WHERE id = ?').get(eventRow.id);
      return;
    }
    result.matched = true;
    const version = rule.current_version;
    const versionedRule = getRuleVersion(rule.id, version); // 不可变快照
    const mergeKey = renderTemplate(versionedRule.merge_key_template, event.payload);
    const parentKey = versionedRule.parent_key_template
      ? renderTemplate(versionedRule.parent_key_template, event.payload) : null;
    // 新告警一律从 warning 起步，升级链决定后续级别
    const initialSeverity = 'warning';

    let alert;
    if (status === 'firing') {
      const open = openAlertByMergeKey(db, rule.id, version, mergeKey);
      if (open) {
        alert = mergeIntoAlert(db, open, event, false);
        if (open.status !== 'firing') {
          // 命中处于人工确认状态的打开告警：保留状态与反馈
          addTimeline(db, open.id, 'feedback_protected',
            `新事件到达，但告警处于 ${open.status}（人工反馈），状态与反馈保持不变`,
            { event_time: event.event_time, event_id: event.id });
        }
      } else {
        const closed = prepare(
          'SELECT * FROM alerts WHERE rule_id = ? AND rule_version = ? AND merge_key = ? ORDER BY updated_at DESC LIMIT 1',
        ).get(rule.id, version, mergeKey);
        if (closed?.status === 'resolved') {
          // 已自动关闭的告警再次触发：重新打开，append-only 的时间线与反馈全部保留
          alert = mergeIntoAlert(db, closed, event, true);
        } else if (closed && (closed.status === 'acknowledged' || closed.status === 'false_positive')) {
          // 人工确认 / 误报反馈不可被自动流程覆盖：事件并入计数，状态不动
          alert = mergeIntoAlert(db, closed, event, false);
          addTimeline(db, closed.id, 'feedback_protected',
            `新事件到达，但告警处于 ${closed.status}（人工反馈），状态与反馈保持不变`,
            { event_time: event.event_time, event_id: event.id });
        } else {          alert = createAlert(db, {
            rule: versionedRule, event, mergeKey, parentKey, severity: initialSeverity,
          });
          if (parentKey) {
            const parent = findParent(db, parentKey, alert.id);
            if (parent && parent.id !== alert.id) {
              linkChild(db, alert, parent, event.event_time);
              // linkChild 更新了 parent_id，重新读取保证返回值是最新状态
              alert = prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id);
            }
          }
        }
      }
      attachEventToAlert(db, eventRow.id, alert, rule.id, version);
      addEvidenceTimeline(db, alert.id, event);
    } else {
      // resolved：优先归并到触发规则自身的同合并键告警（避免与其他规则的同键告警冲突），
      // 找不到再跨规则按对象键兜底（如父键模板与子键模板恰好相同的场景）
      let target = prepare(
        'SELECT * FROM alerts WHERE rule_id = ? AND merge_key = ? ORDER BY updated_at DESC LIMIT 1',
      ).get(rule.id, mergeKey);
      if (!target && parentKey) {
        target = prepare(
          'SELECT * FROM alerts WHERE merge_key = ? ORDER BY updated_at DESC LIMIT 1',
        ).get(parentKey);
      }
      if (!target) {
        // 修复事件先于/无对应告警：仅记录，不凭空创建
        result.event = prepare('SELECT * FROM events WHERE id = ?').get(eventRow.id);
        return;
      }
      attachEventToAlert(db, eventRow.id, target, rule.id, version);
      if (target.status === 'firing') {
        // 父告警（存在子告警）：自身事件先修复时不立即关闭，等待所有子告警闭环后级联关闭
        const childCount = prepare('SELECT COUNT(*) AS n FROM alerts WHERE parent_id = ?').get(target.id).n;
        const openChildren = childCount === 0 ? 0 : prepare(
          "SELECT COUNT(*) AS n FROM alerts WHERE parent_id = ? AND status IN ('firing','acknowledged')",
        ).get(target.id).n;
        if (childCount > 0 && openChildren > 0) {
          addTimeline(db, target.id, 'waiting_children',
            `自身修复事件已到达，仍有 ${openChildren} 个子告警未闭环，暂缓自动关闭`,
            { event_time: event.event_time, event_id: event.id });
        } else {
          resolveAlert(db, target, event.event_time, 'system',
            `修复事件 ${event_id} 到达，自动关闭`);
        }
        if (target.parent_id) maybeAutoCloseParent(db, target.parent_id, event.event_time);
      } else {
        // acknowledged / false_positive / 已 resolved：人工反馈不被覆盖
        addTimeline(db, target.id, 'feedback_protected',
          `修复事件到达，但告警状态为 ${target.status}，保留人工反馈与状态`,
          { event_time: event.event_time, event_id: event.id });
      }
      alert = prepare('SELECT * FROM alerts WHERE id = ?').get(target.id);
    }

    result.alert = alert;
    result.event = prepare('SELECT * FROM events WHERE id = ?').get(eventRow.id);
  });

  tx();
  return result;
}

function attachEventToAlert(db, eventRowId, alert, ruleId, version) {
  prepare('UPDATE events SET alert_id = ?, rule_id = ?, rule_version = ? WHERE id = ?')
    .run(alert.id, ruleId, version, eventRowId);
}

function addEvidenceTimeline(db, alertId, event) {
  addTimeline(db, alertId, 'event', `事件证据：${event.event_id}`, {
    event_time: event.event_time,
    event_id: event.event_id,
    detail: JSON.stringify(event.payload),
  });
}

// ---------- 时间升级 ----------
// 以事件时间为基准：now = max(已接收事件时间)，保证乱序/历史事件也能确定性地升级
export function runEscalations(referenceTime) {
  const db = getDb();
  const ref = referenceTime ?? prepare('SELECT MAX(event_time) AS m FROM events').get()?.m ?? nowIso();
  const fired = [];
  const tx = transaction(() => {
    const alerts = prepare("SELECT * FROM alerts WHERE status = 'firing'").all();
    for (const alert of alerts) {
      const rule = getRuleVersion(alert.rule_id, alert.rule_version);
      const chain = rule.escalations ?? [];
      const elapsedMin = (Date.parse(ref) - Date.parse(alert.last_event_time)) / 60000;
      let level = alert.current_escalation;
      for (let i = 0; i < chain.length; i += 1) {
        if (i + 1 <= level) continue;
        if (elapsedMin >= chain[i].after_minutes) {
          const fromSeverity = alert.severity;
          level = i + 1;
          prepare('UPDATE alerts SET current_escalation = ?, severity = ?, updated_at = ? WHERE id = ?')
            .run(level, chain[i].severity, nowIso(), alert.id);
          alert.current_escalation = level;
          alert.severity = chain[i].severity;
          addTimeline(db, alert.id, 'escalated',
            `升级 L${level}：${chain[i].after_minutes} 分钟未修复 → ${chain[i].severity}`, {
              event_time: ref, from: fromSeverity, to: chain[i].severity, actor: 'system',
              detail: `基准时间 ${ref}，距最近事件 ${elapsedMin.toFixed(1)} 分钟`,
            });
          fired.push({ alert_id: alert.id, level, severity: chain[i].severity });
        }
      }
      // acknowledged/false_positive/resolved 告警不在 firing 查询内，天然不参与升级
    }
  });
  tx();
  return { reference_time: ref, escalated: fired };
}

// ---------- 人工反馈（append-only，不可被自动流程覆盖） ----------
export function addFeedback(alertId, body) {
  const db = getDb();
  const alert = prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  if (!alert) throw new HttpError(404, '告警不存在');
  const kind = body.kind;
  if (!['acknowledge', 'false_positive', 'comment'].includes(kind)) {
    throw new HttpError(400, "kind 仅支持 acknowledge | false_positive | comment");
  }
  const operator = body.operator || 'anonymous';
  const ts = nowIso();

  const tx = transaction(() => {
    prepare(`INSERT INTO alert_feedback (id, alert_id, kind, comment, operator, event_time, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      newId('fb'), alertId, kind, body.comment ?? null, operator, ts, ts,
    );
    if (kind === 'acknowledge') {
      const from = alert.status;
      if (from === 'firing') {
        prepare("UPDATE alerts SET status = 'acknowledged', updated_at = ? WHERE id = ?").run(ts, alertId);
        addTimeline(db, alertId, 'acknowledged', `人工确认（${operator}）`, {
          from, to: 'acknowledged', actor: operator, detail: body.comment ?? null,
        });
      } else {
        addTimeline(db, alertId, 'acknowledged', `人工确认反馈（${operator}），状态保持 ${from}`, {
          actor: operator, detail: body.comment ?? null,
        });
      }
    } else if (kind === 'false_positive') {
      const from = alert.status;
      prepare(`UPDATE alerts SET status = 'false_positive', resolved_at = COALESCE(resolved_at, ?),
        closed_by = ?, updated_at = ? WHERE id = ?`).run(ts, operator, ts, alertId);
      addTimeline(db, alertId, 'false_positive', `标记误报（${operator}）`, {
        from, to: 'false_positive', actor: operator, detail: body.comment ?? null,
      });
    } else {
      addTimeline(db, alertId, 'comment', `备注（${operator}）：${body.comment ?? ''}`, {
        actor: operator, detail: body.comment ?? null,
      });
    }
  });
  tx();
  return getAlertDetail(alertId);
}

// ---------- 查询 ----------
export function listAlerts(filters = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  if (filters.status) {
    where.push('status = ?');
    args.push(filters.status);
  }
  if (filters.severity) {
    where.push('severity = ?');
    args.push(filters.severity);
  }
  if (filters.rule_id) {
    where.push('rule_id = ?');
    args.push(filters.rule_id);
  }
  const sql = `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY last_event_time DESC`;
  const alerts = prepare(sql).all(...args);
  return alerts.map((a) => ({ ...a, children: countChildren(db, a.id) }));
}

function countChildren(db, alertId) {
  return prepare('SELECT COUNT(*) AS n FROM alerts WHERE parent_id = ?').get(alertId).n;
}

export function getAlertDetail(alertId) {
  const db = getDb();
  const alert = prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  if (!alert) throw new HttpError(404, '告警不存在');
  const children = prepare('SELECT * FROM alerts WHERE parent_id = ? ORDER BY created_at').all(alertId);
  const parent = alert.parent_id ? prepare('SELECT * FROM alerts WHERE id = ?').get(alert.parent_id) : null;
  const timeline = prepare(
    'SELECT * FROM alert_timeline WHERE alert_id = ? ORDER BY event_time, recorded_at',
  ).all(alertId);
  const feedback = prepare(
    'SELECT * FROM alert_feedback WHERE alert_id = ? ORDER BY recorded_at',
  ).all(alertId);
  const events = prepare(
    'SELECT * FROM events WHERE alert_id = ? ORDER BY event_time, received_at',
  ).all(alertId).map((e) => ({
    ...e, payload: JSON.parse(e.payload_json), out_of_order: !!e.out_of_order, duplicate: !!e.duplicate,
  }));
  const rule = getRuleVersion(alert.rule_id, alert.rule_version);
  return { ...alert, children, parent, timeline, feedback, events, rule_snapshot: rule };
}

export function listEvents(filters = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  if (filters.event_type) { where.push('event_type = ?'); args.push(filters.event_type); }
  if (filters.out_of_order) { where.push('out_of_order = 1'); }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY received_at DESC LIMIT 500`;
  return prepare(sql).all(...args).map((e) => ({
    ...e, payload: JSON.parse(e.payload_json), out_of_order: !!e.out_of_order, duplicate: !!e.duplicate,
  }));
}

export function getStats() {
  const db = getDb();
  const byStatus = prepare('SELECT status, COUNT(*) AS n FROM alerts GROUP BY status').all();
  const bySeverity = prepare('SELECT severity, COUNT(*) AS n FROM alerts GROUP BY severity').all();
  const totals = prepare(
    `SELECT
       (SELECT COUNT(*) FROM events) AS events_total,
       (SELECT COUNT(*) FROM events WHERE out_of_order = 1) AS out_of_order,
       (SELECT COUNT(*) FROM events WHERE duplicate = 1) AS duplicate_events,
       (SELECT COUNT(*) FROM events WHERE idempotency_key LIKE 'cb:%') AS callback_events,
       (SELECT COUNT(*) FROM alert_feedback) AS feedback_total`,
  ).get();
  const watermarkRow = prepare('SELECT event_type, MAX(event_time) AS watermark FROM events GROUP BY event_type').all();
  return {
    alerts_by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    alerts_by_severity: Object.fromEntries(bySeverity.map((r) => [r.severity, r.n])),
    ...totals,
    watermarks: Object.fromEntries(watermarkRow.map((r) => [r.event_type, r.watermark])),
    severity_order: SEVERITY_ORDER,
  };
}
