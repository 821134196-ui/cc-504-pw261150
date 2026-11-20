import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, t, qualityRule, firingEvent } from './helpers.js';

let ctx;
beforeEach(async () => { ctx = await freshEngine(); });
afterEach(() => ctx.cleanup());

describe('事件接入与规则匹配', () => {
  test('未命中规则的事件只落库，不产生告警', () => {
    const { engine } = ctx;
    const res = engine.ingestEvent(firingEvent({ payload: { metric: 'other' } }));
    assert.equal(res.matched, false);
    assert.equal(res.alert, null);
    assert.equal(engine.listAlerts().length, 0);
    assert.equal(engine.listEvents().length, 1);
  });

  test('match 支持 eq/in/gt/lt/contains/exists 操作符', () => {
    const { rules, engine } = ctx;
    const r = rules.createRule({
      name: '复合匹配', event_type: 'data_quality',
      match: [
        { path: 'value', op: 'gte', value: 0.1 },
        { path: 'dimensions.region', op: 'in', value: ['cn', 'us'] },
        { path: 'trace', op: 'exists', value: true },
      ],
      merge_key_template: 'x:{dimensions.region}',
    });
    assert.ok(r.id);
    const hit = engine.ingestEvent(firingEvent({
      payload: { metric: 'null_rate', value: 0.3, trace: 'abc', dimensions: { region: 'cn' } },
    }));
    assert.equal(hit.matched, true);
    const miss = engine.ingestEvent(firingEvent({
      event_id: 'e2', payload: { metric: 'null_rate', value: 0.3, dimensions: { region: 'cn' } },
    }));
    assert.equal(miss.matched, false); // 缺 trace 字段
  });

  test('非法入参返回明确错误', () => {
    const { engine } = ctx;
    assert.throws(() => engine.ingestEvent({}), /event_id 必填/);
    assert.throws(() => engine.ingestEvent(firingEvent({ status: 'weird' })), /status/);
    assert.throws(() => engine.ingestEvent(firingEvent({ event_time: 'nope' })), /event_time/);
  });
});

describe('告警合并（去重）', () => {
  test('同合并键的重复 firing 事件合并到同一告警并累加 dedupe_count', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const r1 = engine.ingestEvent(firingEvent({ event_id: 'a', event_time: t(0) }));
    const r2 = engine.ingestEvent(firingEvent({ event_id: 'b', event_time: t(1) }));
    const r3 = engine.ingestEvent(firingEvent({
      event_id: 'c', event_time: t(2),
      payload: { metric: 'null_rate', dimensions: { table: 'orders', region: 'us' } },
    }));
    assert.equal(r1.alert.id, r2.alert.id);
    assert.notEqual(r1.alert.id, r3.alert.id);
    const detail = engine.getAlertDetail(r1.alert.id);
    assert.equal(detail.dedupe_count, 2);
    assert.equal(detail.events.length, 2);
    // 时间线包含创建 + 一次合并 + 两条证据
    const kinds = detail.timeline.map((x) => x.event_type);
    assert.ok(kinds.includes('created'));
    assert.ok(kinds.includes('deduplicated'));
  });

  test('同 event_id 再次上报标记 duplicate 但仍走处理管线', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    engine.ingestEvent(firingEvent({ event_id: 'dup', event_time: t(0) }));
    const again = engine.ingestEvent(firingEvent({ event_id: 'dup', event_time: t(1) }));
    assert.equal(again.duplicate, true);
    assert.ok(again.alert);
    assert.equal(engine.getStats().duplicate_events, 1);
  });
});

describe('幂等与重复回调', () => {
  test('相同 callback_id 的重复回调零副作用，原样返回首次结果', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const body = firingEvent({ event_id: 'cb1', callback_id: 'callback-xyz' });
    const first = engine.ingestEvent(body);
    const second = engine.ingestEvent({ ...body, payload: { tampered: true } });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.event.id, second.event.id);
    assert.equal(first.alert.id, second.alert.id);
    // 篡改内容未生效：事件仍只有 1 条，payload 是首次的
    const ev = engine.listEvents()[0];
    assert.deepEqual(ev.payload, body.payload);
    assert.equal(engine.listEvents().length, 1);
  });

  test('无 callback_id 时按 event_id+status+event_time 幂等', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const body = firingEvent({ event_id: 'idem' });
    engine.ingestEvent(body);
    const again = engine.ingestEvent(body);
    assert.equal(again.duplicate, true);
    assert.equal(engine.listEvents().length, 1);
    // 同 event_id 不同时间不算重复回调，而是新事件（标记 duplicate 事件）
    const later = engine.ingestEvent(firingEvent({ event_id: 'idem', event_time: t(5) }));
    assert.equal(later.duplicate, true);
    assert.equal(engine.listEvents().length, 2);
  });
});

describe('乱序事件', () => {
  test('event_time 早于该类型水位的事件标记 out_of_order', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    engine.ingestEvent(firingEvent({ event_id: 'late-base', event_time: t(10) }));
    const late = engine.ingestEvent(firingEvent({ event_id: 'late-1', event_time: t(2) }));
    assert.equal(late.out_of_order, true);
    assert.equal(engine.getStats().out_of_order, 1);
  });

  test('迟到事件并入既有告警且不回拨 last_event_time（升级计时不被污染）', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    const base = engine.ingestEvent(firingEvent({ event_id: 'base', event_time: t(10) }));
    engine.ingestEvent(firingEvent({ event_id: 'late', event_time: t(0) }));
    const detail = engine.getAlertDetail(base.alert.id);
    assert.equal(detail.last_event_time, t(10)); // 未被 t(0) 回拨
    assert.equal(detail.first_event_time, t(0)); // 最早时间正确下探
    const tick = engine.runEscalations(t(14)); // 距最近事件仅 4 分钟，不能升级
    assert.equal(tick.escalated.length, 0);
  });

  test('不同事件类型各自维护独立水位', () => {
    const { rules, engine } = ctx;
    rules.createRule(qualityRule());
    rules.createRule({
      name: '延迟规则', event_type: 'latency', merge_key_template: 'l:{dimensions.host}',
      match: [{ path: 'metric', op: 'eq', value: 'p99' }],
    });
    engine.ingestEvent({
      event_id: 'q1', event_type: 'data_quality', status: 'firing', event_time: t(10),
      payload: { metric: 'null_rate', dimensions: { table: 'o', region: 'cn' } },
    });
    const latency = engine.ingestEvent({
      event_id: 'l1', event_type: 'latency', status: 'firing', event_time: t(1),
      payload: { metric: 'p99', dimensions: { host: 'h1' } },
    });
    assert.equal(latency.out_of_order, false); // latency 类型的首个事件
  });
});
