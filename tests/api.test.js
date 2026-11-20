import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

let counter = 0;

async function startServer() {
  counter += 1;
  const dbPath = path.resolve(`data/http-test-${process.pid}-${counter}.db`);
  process.env.ALERT_DB = dbPath;
  process.env.PORT = String(5100 + counter);
  process.env.TICK_MS = '999999999'; // 关闭后台 ticker 干扰
  const serverMod = await import(`../src/server.js?bust=${counter}`);
  const server = serverMod.start();
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${process.env.PORT}`;
  return {
    base,
    request: (p, opts = {}) => fetch(base + p, {
      headers: { 'content-type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(async (res) => ({ status: res.status, body: await res.json() })),
    stop: async () => {
      await new Promise((r) => server.close(r));
      await serverMod.stop();
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
      }
    },
  };
}

describe('HTTP API', () => {
  let srv;
  beforeEach(async () => { srv = await startServer(); });
  afterEach(async () => { await srv.stop(); });

  test('健康检查', async () => {
    const r = await srv.request('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test('规则 CRUD + 版本列表', async () => {
    const created = await srv.request('/api/rules', { method: 'POST', body: {
      name: 'API 规则', event_type: 'data_quality',
      merge_key_template: 'k:{dimensions.region}',
      match: [{ path: 'metric', op: 'eq', value: 'x' }],
      escalations: [{ after_minutes: 3, severity: 'major' }],
    } });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const updated = await srv.request(`/api/rules/${id}`, { method: 'PUT', body: {
      ...created.body, name: 'API 规则 v2',
      merge_key_template: 'k2:{dimensions.region}',
    } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.current_version, 2);

    const versions = await srv.request(`/api/rules/${id}/versions`);
    assert.equal(versions.body.length, 2);
    assert.equal(versions.body[0].merge_key_template, 'k:{dimensions.region}');
  });

  test('事件接入 → 告警产生 → 反馈 → 修复全链路', async () => {
    const rule = await srv.request('/api/rules', { method: 'POST', body: {
      name: '链路规则', event_type: 'biz', merge_key_template: 'b:{dimensions.channel}',
      match: [{ path: 'metric', op: 'eq', value: 'pay' }],
      escalations: [{ after_minutes: 5, severity: 'critical' }],
    } });

    const ingested = await srv.request('/api/events', { method: 'POST', body: {
      event_id: 'api-1', event_type: 'biz', status: 'firing',
      event_time: '2026-11-20T09:00:00Z',
      payload: { metric: 'pay', dimensions: { channel: 'zfb' } },
    } });
    assert.equal(ingested.status, 202);
    const alertId = ingested.body.alert.id;

    // 重复回调
    const dup = await srv.request('/api/events', { method: 'POST', body: {
      event_id: 'api-1', event_type: 'biz', status: 'firing',
      event_time: '2026-11-20T09:00:00Z', callback_id: 'cb-1',
      payload: { metric: 'pay', dimensions: { channel: 'zfb' } },
    } });
    const dup2 = await srv.request('/api/events', { method: 'POST', body: dup.body.event ? {
      event_id: 'api-1', event_type: 'biz', status: 'firing',
      event_time: '2026-11-20T09:00:00Z', callback_id: 'cb-1',
      payload: { metric: 'PAYLOAD_TAMPERED' },
    } : {} });
    assert.equal(dup2.body.duplicate, true);

    // 反馈
    const fb = await srv.request(`/api/alerts/${alertId}/feedback`, { method: 'POST', body: {
      kind: 'comment', operator: 'tester', comment: 'API 备注',
    } });
    assert.equal(fb.status, 201);
    assert.equal(fb.body.feedback.length, 1);

    // 手动升级 tick
    const tick = await srv.request('/api/escalations/tick', { method: 'POST', body: {
      reference_time: '2026-11-20T09:06:00Z',
    } });
    assert.equal(tick.body.escalated[0].severity, 'critical');

    // 修复关闭
    const repaired = await srv.request('/api/events', { method: 'POST', body: {
      event_id: 'api-1-r', event_type: 'biz', status: 'resolved',
      event_time: '2026-11-20T09:07:00Z',
      payload: { metric: 'pay', dimensions: { channel: 'zfb' } },
    } });
    assert.equal(repaired.body.alert.status, 'resolved');

    // 列表过滤
    const list = await srv.request('/api/alerts?status=resolved');
    assert.ok(list.body.every((a) => a.status === 'resolved'));
  });

  test('错误入参返回 4xx 而非 500', async () => {
    const bad = await srv.request('/api/events', { method: 'POST', body: { hello: 'world' } });
    assert.equal(bad.status, 400);
    const missing = await srv.request('/api/alerts/nonexistent_id');
    assert.equal(missing.status, 404);
    const noRoute = await srv.request('/api/nope');
    assert.equal(noRoute.status, 404);
  });

  test('静态前端可访问', async () => {
    const r = await fetch(`${srv.base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
  });
});
