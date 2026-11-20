// 规则服务：创建/更新均产生不可变版本快照；旧版本永远保留，事件按入站时的当前版本匹配
import { getDb, mapRule, mapRuleVersion, prepare } from './db.js';
import { newId, nowIso, HttpError } from './util.js';

const VALID_SEVERITIES = new Set(['info', 'warning', 'major', 'critical']);

function validateRuleInput(body) {
  const { name, event_type, merge_key_template, match, escalations } = body;
  if (!name || typeof name !== 'string') throw new HttpError(400, 'name 必填');
  if (!event_type || typeof event_type !== 'string') throw new HttpError(400, 'event_type 必填');
  if (!merge_key_template || typeof merge_key_template !== 'string') {
    throw new HttpError(400, 'merge_key_template 必填');
  }
  if (match !== undefined && !Array.isArray(match)) throw new HttpError(400, 'match 必须是数组');
  if (escalations !== undefined) {
    if (!Array.isArray(escalations)) throw new HttpError(400, 'escalations 必须是数组');
    for (const esc of escalations) {
      if (!Number.isInteger(esc.after_minutes) || esc.after_minutes < 0) {
        throw new HttpError(400, '升级项 after_minutes 必须是非负整数');
      }
      if (!VALID_SEVERITIES.has(esc.severity)) {
        throw new HttpError(400, `升级项 severity 非法：${esc.severity}`);
      }
    }
    // 时间阈值必须递增，便于按顺序推进
    const mins = escalations.map((e) => e.after_minutes);
    if (mins.some((m, i) => i > 0 && m <= mins[i - 1])) {
      throw new HttpError(400, '升级链 after_minutes 必须严格递增');
    }
  }
}

function snapshotVersion(db, ruleId, version, row, ts) {
  prepare(`INSERT INTO rule_versions
    (rule_id, version, name, event_type, match_json, merge_key_template, parent_key_template, escalations_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ruleId, version, row.name, row.event_type, row.match_json, row.merge_key_template,
    row.parent_key_template, row.escalations_json, ts,
  );
}

export function createRule(body) {
  validateRuleInput(body);
  const db = getDb();
  const ts = nowIso();
  const id = newId('rule');
  const row = {
    name: body.name,
    event_type: body.event_type,
    match_json: JSON.stringify(body.match ?? []),
    merge_key_template: body.merge_key_template,
    parent_key_template: body.parent_key_template ?? null,
    escalations_json: JSON.stringify(body.escalations ?? []),
  };
  prepare(`INSERT INTO rules
    (id, name, event_type, match_json, merge_key_template, parent_key_template, escalations_json,
     current_version, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
    id, row.name, row.event_type, row.match_json, row.merge_key_template,
    row.parent_key_template, row.escalations_json, body.enabled === false ? 0 : 1, ts, ts,
  );
  snapshotVersion(db, id, 1, row, ts);
  return getRule(id);
}

export function updateRule(id, body) {
  const db = getDb();
  const existing = prepare('SELECT * FROM rules WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, '规则不存在');

  // 启用/停用不算内容变更，不产生新版本
  if (body.enabled !== undefined && Object.keys(body).every((k) => k === 'enabled')) {
    prepare('UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(body.enabled ? 1 : 0, nowIso(), id);
    return getRule(id);
  }

  validateRuleInput({ ...existing, ...body });
  const nextVersion = existing.current_version + 1;
  const ts = nowIso();
  const row = {
    name: body.name ?? existing.name,
    event_type: body.event_type ?? existing.event_type,
    match_json: body.match !== undefined ? JSON.stringify(body.match) : existing.match_json,
    merge_key_template: body.merge_key_template ?? existing.merge_key_template,
    parent_key_template: body.parent_key_template !== undefined
      ? body.parent_key_template : existing.parent_key_template,
    escalations_json: body.escalations !== undefined
      ? JSON.stringify(body.escalations) : existing.escalations_json,
  };
  prepare(`UPDATE rules SET
      name = ?, event_type = ?, match_json = ?, merge_key_template = ?,
      parent_key_template = ?, escalations_json = ?, current_version = ?, updated_at = ?
    WHERE id = ?`).run(
    row.name, row.event_type, row.match_json, row.merge_key_template,
    row.parent_key_template, row.escalations_json, nextVersion, ts, id,
  );
  snapshotVersion(db, id, nextVersion, row, ts);
  return getRule(id);
}

export function getRule(id) {
  const r = getDb().prepare('SELECT * FROM rules WHERE id = ?').get(id);
  if (!r) throw new HttpError(404, '规则不存在');
  return mapRule(r);
}

export function listRules() {
  return getDb().prepare('SELECT * FROM rules ORDER BY created_at').all().map(mapRule);
}

export function listRuleVersions(id) {
  getRule(id); // 存在性校验
  return getDb()
    .prepare('SELECT * FROM rule_versions WHERE rule_id = ? ORDER BY version')
    .all(id)
    .map(mapRuleVersion);
}

// 取某个具体版本快照（升级等后续流程始终按告警创建时的版本执行）
export function getRuleVersion(ruleId, version) {
  const v = getDb()
    .prepare('SELECT * FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(ruleId, version);
  if (!v) throw new HttpError(500, `规则版本缺失：${ruleId}@v${version}`);
  return mapRuleVersion(v);
}

// 返回当前启用且类型匹配的规则
export function findEnabledRules(eventType) {
  return getDb()
    .prepare('SELECT * FROM rules WHERE enabled = 1 AND event_type = ? ORDER BY created_at')
    .all(eventType)
    .map(mapRule);
}
