import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, t, qualityRule, firingEvent } from './helpers.js';

let ctx;
beforeEach(async () => { ctx = await freshEngine(); });
afterEach(() => ctx.cleanup());

describe('时间升级', () => {
  test('按事件时间阈值逐级升级，跨级 tick 可连跳', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const r = engine.ingestEvent(firingEvent({ event_time: t(0) }));
    assert.equal(r.alert.severity, 'warning');
    assert.equal(r.alert.current_escalation, 0);

    let tick = engine.runEscalations(t(4));
    assert.equal(tick.escalated.length, 0);
    tick = engine.runEscalations(t(5));
    assert.equal(tick.escalated.length, 1);
    let detail = engine.getAlertDetail(r.alert.id);
    assert.equal(detail.severity, 'major');
    assert.equal(detail.current_escalation, 1);

    // 再次 tick 不重复升级同一级
    tick = engine.runEscalations(t(10));
    assert.equal(tick.escalated.length, 0);

    // 跨级 tick（直接到 20 分钟）连跳到 L2
    tick = engine.runEscalations(t(20));
    assert.equal(tick.escalated.length, 1);
    detail = engine.getAlertDetail(r.alert.id);
    assert.equal(detail.severity, 'critical');
    assert.equal(detail.current_escalation, 2);
    const escTl = detail.timeline.filter((x) => x.event_type === 'escalated');
    assert.equal(escTl.length, 2);
  });

  test('resolved/acknowledged/false_positive 告警不参与升级', () => {
    const { rules, engine } = ctx;
    const rule = rules.createRule(qualityRule());
    const a = engine.ingestEvent(firingEvent({ event_id: 'a', event_time: t(0) }));
    const b = engine.ingestEvent(firingEvent({
      event_id: 'b', event_time: t(0),
      payload: { metric: 'null_rate', dimensions: { table: 'users', region: 'cn' } },
    }));
    engine.addFeedback(a.alert.id, { kind: 'acknowledge', operator: 'op1' });
    engine.ingestEvent({
      event_id: 'b-r', event_type: 'data_quality', status: 'resolved', event_time: t(1),
      payload: { metric: 'null_rate', dimensions: { table: 'users', region: 'cn' } },
    });
    const tick = engine.runEscalations(t(30));
    const upgraded = new Set(tick.escalated.map((x) => x.alert_id));
    assert.equal(upgraded.has(a.alert.id), false);
    assert.equal(upgraded.has(b.alert.id), false);
    assert.equal(engine.getAlertDetail(a.alert.id).current_escalation, 0);
    assert.equal(engine.getAlertDetail(b.alert.id).status, 'resolved');
    assert.ok(rule.id);
  });
});

describe('修复自动关闭与反馈保护', () => {
  test('resolved 事件自动关闭 firing 告警', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const r = engine.ingestEvent(firingEvent({ event_id: 'a', event_time: t(0) }));
    const close = engine.ingestEvent({
      event_id: 'a-r', event_type: 'data_quality', status: 'resolved', event_time: t(2),
      payload: { metric: 'null_rate', dimensions: { table: 'orders', region: 'cn' } },
    });
    assert.equal(close.alert.status, 'resolved');
    assert.equal(close.alert.closed_by, 'system');
    const detail = engine.getAlertDetail(r.alert.id);
    assert.ok(detail.resolved_at);
    assert.ok(detail.timeline.some((x) => x.event_type === 'resolved'));
  });

  test('resolved 告警再次触发会重开，但反馈与时间线完整保留', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const r = engine.ingestEvent(firingEvent({ event_id: 'a', event_time: t(0) }));
    engine.ingestEvent({
      event_id: 'a-r', event_type: 'data_quality', status: 'resolved', event_time: t(2),
      payload: { metric: 'null_rate', dimensions: { table: 'orders', region: 'cn' } },
    });
    const reopen = engine.ingestEvent(firingEvent({ event_id: 'a2', event_time: t(8) }));
    assert.equal(reopen.alert.id, r.alert.id);
    assert.equal(reopen.alert.status, 'firing');
    assert.equal(reopen.alert.resolved_at, null);
    const detail = engine.getAlertDetail(r.alert.id);
    assert.ok(detail.timeline.some((x) => x.event_type === 'reopened'));
    assert.ok(detail.timeline.some((x) => x.event_type === 'resolved'));
  });

  test('人工确认后：新 firing 事件与 resolved 事件都不能覆盖确认状态', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const r = engine.ingestEvent(firingEvent({ event_id: 'a', event_time: t(0) }));
    engine.addFeedback(r.alert.id, { kind: 'acknowledge', operator: 'zhang', comment: '跟进中' });

    const more = engine.ingestEvent(firingEvent({ event_id: 'a2', event_time: t(3) }));
    assert.equal(more.alert.status, 'acknowledged');
    assert.equal(more.alert.dedupe_count, 2); // 事件仍并入计数

    const repair = engine.ingestEvent({
      event_id: 'a-r', event_type: 'data_quality', status: 'resolved', event_time: t(4),
      payload: { metric: 'null_rate', dimensions: { table: 'orders', region: 'cn' } },
    });
    assert.equal(repair.alert.status, 'acknowledged');
    const detail = engine.getAlertDetail(r.alert.id);
    assert.equal(detail.feedback.length, 1);
    assert.equal(detail.feedback[0].operator, 'zhang');
    assert.ok(detail.timeline.filter((x) => x.event_type === 'feedback_protected').length >= 2);
  });

  test('误报反馈后新事件不能重开，误报状态永久保留', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const r = engine.ingestEvent(firingEvent({ event_id: 'a', event_time: t(0) }));
    engine.addFeedback(r.alert.id, { kind: 'false_positive', operator: 'li', comment: '口径问题' });
    const again = engine.ingestEvent(firingEvent({ event_id: 'a2', event_time: t(5) }));
    assert.equal(again.alert.status, 'false_positive');
    assert.equal(again.alert.dedupe_count, 2);
    const repair = engine.ingestEvent({
      event_id: 'a-r', event_type: 'data_quality', status: 'resolved', event_time: t(6),
      payload: { metric: 'null_rate', dimensions: { table: 'orders', region: 'cn' } },
    });
    assert.equal(repair.alert.status, 'false_positive');
    // 反馈表只追加：两条反馈场景下也没有更新/删除路径
    const detail = engine.getAlertDetail(r.alert.id);
    assert.equal(detail.feedback.length, 1);
    assert.equal(detail.feedback[0].kind, 'false_positive');
  });

  test('无对应告警的 resolved 事件只落库，不凭空创建告警', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const res = engine.ingestEvent({
      event_id: 'ghost-r', event_type: 'data_quality', status: 'resolved', event_time: t(0),
      payload: { metric: 'null_rate', dimensions: { table: 'ghost', region: 'cn' } },
    });
    assert.equal(res.matched, true);
    assert.equal(res.alert, null);
    assert.equal(engine.listAlerts().length, 0);
  });
});

describe('父子关系', () => {
  function parentChildRules(rules) {
    const parent = rules.createRule({
      name: '主机异常', event_type: 'infra',
      match: [{ path: 'metric', op: 'eq', value: 'host' }],
      merge_key_template: 'host:{dimensions.host}',
    });
    const child = rules.createRule({
      name: '服务异常', event_type: 'infra',
      match: [{ path: 'metric', op: 'eq', value: 'svc' }],
      merge_key_template: 'svc:{dimensions.service}',
      parent_key_template: 'host:{dimensions.host}',
    });
    return { parent, child };
  }

  const infraEvent = (event_id, metric, min, extra = {}) => ({
    event_id, event_type: 'infra', status: 'firing', event_time: t(min),
    payload: {
      metric,
      dimensions: { host: 'h-1', service: 's-1', ...(extra.dimensions ?? {}) },
    },
  });

  test('子告警自动挂载到同 parent_key 的父告警', () => {
    const { rules, engine } = ctx;
    parentChildRules(rules);
    engine.ingestEvent(infraEvent('p1', 'host', 0));
    const childRes = engine.ingestEvent(infraEvent('c1', 'svc', 1));
    assert.ok(childRes.alert.parent_id);
    const detail = engine.getAlertDetail(childRes.alert.id);
    assert.equal(detail.parent.merge_key, 'host:h-1');
    const parentDetail = engine.getAlertDetail(detail.parent.id);
    assert.equal(parentDetail.children.length, 1);
    assert.ok(parentDetail.timeline.some((x) => x.event_type === 'child_attached'));
  });

  test('父告警在自身事件修复且全部子告警闭环后自动关闭', () => {
    const { rules, engine } = ctx;
    parentChildRules(rules);
    const p = engine.ingestEvent(infraEvent('p1', 'host', 0));
    const c1 = engine.ingestEvent(infraEvent('c1', 'svc', 1));
    const c2 = engine.ingestEvent(infraEvent('c2', 'svc', 2, { dimensions: { service: 's-2' } }));

    // 先修复父自身：子仍开着 → 不能关
    engine.ingestEvent({ ...infraEvent('p1-r', 'host', 3), status: 'resolved' });
    assert.equal(engine.getAlertDetail(p.alert.id).status, 'firing');

    engine.ingestEvent({ ...infraEvent('c1-r', 'svc', 4), status: 'resolved' });
    assert.equal(engine.getAlertDetail(p.alert.id).status, 'firing'); // 还有一个子开着
    engine.ingestEvent({ ...infraEvent('c2-r', 'svc', 5, { dimensions: { service: 's-2' } }), status: 'resolved' });
    assert.equal(engine.getAlertDetail(p.alert.id).status, 'resolved'); // 全部闭环
    assert.equal(engine.getAlertDetail(c1.alert.id).status, 'resolved');
    assert.equal(engine.getAlertDetail(c2.alert.id).status, 'resolved');
  });

  test('父告警已人工确认时，即使全部闭环也不自动改状态', () => {
    const { rules, engine } = ctx;
    parentChildRules(rules);
    const p = engine.ingestEvent(infraEvent('p1', 'host', 0));
    const c1 = engine.ingestEvent(infraEvent('c1', 'svc', 1));
    engine.addFeedback(p.alert.id, { kind: 'acknowledge', operator: 'boss' });
    engine.ingestEvent({ ...infraEvent('p1-r', 'host', 3), status: 'resolved' });
    engine.ingestEvent({ ...infraEvent('c1-r', 'svc', 4), status: 'resolved' });
    const detail = engine.getAlertDetail(p.alert.id);
    assert.equal(detail.status, 'acknowledged');
    assert.ok(detail.timeline.some((x) => x.event_type === 'auto_close_skipped'));
  });
});

describe('规则版本化：变更只影响新事件', () => {
  test('更新规则产生新版本，存量告警快照在旧版本上继续运行', () => {
    const { rules, engine } = ctx;
    const rule = rules.createRule(qualityRule());
    const old = engine.ingestEvent(firingEvent({ event_id: 'old', event_time: t(0) }));
    assert.equal(old.alert.rule_version, 1);

    rules.updateRule(rule.id, {
      ...qualityRule(),
      merge_key_template: 'qv2:{dimensions.table}:{dimensions.region}',
      escalations: [{ after_minutes: 1, severity: 'critical' }],
    });
    const versions = rules.listRuleVersions(rule.id);
    assert.equal(versions.length, 2);

    const fresh = engine.ingestEvent(firingEvent({ event_id: 'new', event_time: t(1) }));
    assert.equal(fresh.alert.rule_version, 2);
    assert.notEqual(fresh.alert.id, old.alert.id); // 新合并键 → 新告警
    assert.equal(fresh.alert.merge_key.startsWith('qv2:'), true);

    // 老告警仍引用 v1 快照与升级链（5 分钟才升级；v2 是 1 分钟）
    const tick = engine.runEscalations(t(3));
    const oldDetail = engine.getAlertDetail(old.alert.id);
    assert.equal(oldDetail.current_escalation, 0);
    assert.equal(oldDetail.rule_snapshot.version, 1);
    assert.equal(tick.escalated.some((x) => x.alert_id === fresh.alert.id), true);
  });

  test('仅启用/停用不产生新版本；停用后新事件不再匹配', () => {
    const { rules, engine } = ctx;
    const rule = rules.createRule(qualityRule());
    rules.updateRule(rule.id, { enabled: false });
    assert.equal(rules.listRuleVersions(rule.id).length, 1);
    const res = engine.ingestEvent(firingEvent({ event_id: 'x' }));
    assert.equal(res.matched, false);
    rules.updateRule(rule.id, { enabled: true });
    const res2 = engine.ingestEvent(firingEvent({ event_id: 'y' }));
    assert.equal(res2.matched, true);
  });

  test('非法升级链（阈值非递增）被拒绝', () => {
    const { rules } = ctx;
    assert.throws(() => rules.createRule({
      name: 'bad', event_type: 'data_quality', merge_key_template: 'x:{a}',
      escalations: [
        { after_minutes: 10, severity: 'major' },
        { after_minutes: 5, severity: 'critical' },
      ],
    }), /严格递增/);
  });
});
