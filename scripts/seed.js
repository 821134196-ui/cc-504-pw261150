// 种子数据：构造覆盖全部核心语义的演示场景
// 用法：npm run seed   （会重置 data/alert-center.db）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = path.join(__dirname, '..', 'data', 'alert-center.db');
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(dbFile + ext); } catch { /* ignore */ }
}

const { openDb, closeDb } = await import('../src/db.js');
openDb(dbFile);
const { createRule, listRules } = await import('../src/rules.js');
const engine = await import('../src/engine.js');

const t = new Date('2026-11-20T09:00:00.000Z');
const at = (min) => new Date(t.getTime() + min * 60000).toISOString();
const post = (body) => engine.ingestEvent(body);

// ---------- 规则 ----------
const qualityRule = createRule({
  name: '数据质量-空值率',
  event_type: 'data_quality',
  match: [{ path: 'metric', op: 'eq', value: 'null_rate' }],
  merge_key_template: 'null_rate:{dimensions.table}:{dimensions.region}',
  parent_key_template: null,
  escalations: [
    { after_minutes: 5, severity: 'major', label: '值班升级' },
    { after_minutes: 15, severity: 'critical', label: '负责人升级' },
  ],
});

const latencyRule = createRule({
  name: '延迟-P99 超时',
  event_type: 'latency',
  match: [{ path: 'metric', op: 'in', value: ['p99_latency', 'p95_latency'] }],
  merge_key_template: 'latency:{dimensions.service}',
  parent_key_template: 'host:{dimensions.host}',
  escalations: [
    { after_minutes: 10, severity: 'major', label: 'SRE 升级' },
    { after_minutes: 30, severity: 'critical', label: '总监升级' },
  ],
});

const hostRule = createRule({
  name: '主机-网络异常',
  event_type: 'latency',
  match: [{ path: 'metric', op: 'eq', value: 'host_net_error' }],
  merge_key_template: 'host:{dimensions.host}',
  escalations: [{ after_minutes: 20, severity: 'critical', label: '网络负责人' }],
});

const bizRule = createRule({
  name: '业务-支付成功率',
  event_type: 'business',
  match: [{ path: 'metric', op: 'eq', value: 'pay_success_rate' }, { path: 'value', op: 'lt', value: 0.95 }],
  merge_key_template: 'pay:{dimensions.channel}',
  escalations: [{ after_minutes: 5, severity: 'critical', label: '支付负责人' }],
});

console.log('已创建规则：', listRules().map((r) => `${r.name} v1`).join(' | '));

// ---------- 场景 1：合并 + 升级（数据质量） ----------
post({
  event_id: 'q-001', event_type: 'data_quality', status: 'firing', event_time: at(0),
  payload: { metric: 'null_rate', value: 0.18, threshold: 0.05, dimensions: { table: 'orders', region: 'cn' } },
});
post({
  event_id: 'q-002', event_type: 'data_quality', status: 'firing', event_time: at(2),
  payload: { metric: 'null_rate', value: 0.21, threshold: 0.05, dimensions: { table: 'orders', region: 'cn' } },
}); // 同合并键 → 合并，dedupe_count=2
post({
  event_id: 'q-003', event_type: 'data_quality', status: 'firing', event_time: at(3),
  payload: { metric: 'null_rate', value: 0.09, threshold: 0.05, dimensions: { table: 'orders', region: 'us' } },
}); // 不同 region → 独立告警

// ---------- 场景 2：父子关系（主机 → 服务延迟） ----------
post({
  event_id: 'h-001', event_type: 'latency', status: 'firing', event_time: at(1),
  payload: { metric: 'host_net_error', value: 42, dimensions: { host: 'host-7', service: 'pay-svc' } },
}); // 父告警 host:host-7
post({
  event_id: 'l-001', event_type: 'latency', status: 'firing', event_time: at(2),
  payload: { metric: 'p99_latency', value: 1820, threshold: 800, dimensions: { service: 'pay-svc', host: 'host-7' } },
}); // 子告警，parent_key=host:host-7 → 自动挂到父告警
post({
  event_id: 'l-002', event_type: 'latency', status: 'firing', event_time: at(4),
  payload: { metric: 'p95_latency', value: 990, threshold: 500, dimensions: { service: 'order-svc', host: 'host-7' } },
}); // 第二个子告警

// ---------- 场景 3：业务异常 + 人工确认（反馈保护） ----------
post({
  event_id: 'b-001', event_type: 'business', status: 'firing', event_time: at(1),
  payload: { metric: 'pay_success_rate', value: 0.87, threshold: 0.95, dimensions: { channel: 'alipay' } },
});
const bizAlert = engine.listAlerts({ rule_id: bizRule.id })[0];
engine.addFeedback(bizAlert.id, {
  kind: 'acknowledge', operator: 'zhang.san', comment: '已联系支付渠道排查，升级冻结',
});
post({
  event_id: 'b-002', event_type: 'business', status: 'firing', event_time: at(6),
  payload: { metric: 'pay_success_rate', value: 0.82, threshold: 0.95, dimensions: { channel: 'alipay' } },
}); // 新事件并入，acknowledged 状态不被覆盖、不升级
post({
  event_id: 'b-003', event_type: 'business', status: 'resolved', event_time: at(8),
  payload: { metric: 'pay_success_rate', value: 0.98, dimensions: { channel: 'alipay' } },
}); // 修复事件到达 → 仍保留 acknowledged，不自动关闭

// ---------- 场景 4：误报反馈 ----------
post({
  event_id: 'b-101', event_type: 'business', status: 'firing', event_time: at(2),
  payload: { metric: 'pay_success_rate', value: 0.91, threshold: 0.95, dimensions: { channel: 'wechat' } },
});
const fpAlert = engine.listAlerts({ rule_id: bizRule.id }).find((a) => a.merge_key.endsWith('wechat'));
engine.addFeedback(fpAlert.id, { kind: 'false_positive', operator: 'li.si', comment: '统计口径变更导致，非真实故障' });
post({
  event_id: 'b-102', event_type: 'business', status: 'firing', event_time: at(7),
  payload: { metric: 'pay_success_rate', value: 0.93, threshold: 0.95, dimensions: { channel: 'wechat' } },
}); // 误报状态不被新事件覆盖

// ---------- 场景 5：正常修复自动关闭 ----------
post({
  event_id: 'q-101', event_type: 'data_quality', status: 'firing', event_time: at(1),
  payload: { metric: 'null_rate', value: 0.12, dimensions: { table: 'users', region: 'cn' } },
});
post({
  event_id: 'q-102', event_type: 'data_quality', status: 'resolved', event_time: at(5),
  payload: { metric: 'null_rate', value: 0.01, dimensions: { table: 'users', region: 'cn' } },
}); // → resolved 自动关闭

// ---------- 场景 6：乱序事件（event_time 早于水位） ----------
post({
  event_id: 'q-002-late', event_type: 'data_quality', status: 'firing', event_time: at(-10),
  payload: { metric: 'null_rate', value: 0.16, dimensions: { table: 'orders', region: 'cn' } },
  callback_id: 'cb-late-001',
}); // out_of_order=true，并入既有合并告警作为迟到证据

// ---------- 场景 7：重复回调（同 callback_id 两次，第二次必须零副作用） ----------
const cbPayload = {
  event_id: 'h-002', event_type: 'latency', status: 'firing', event_time: at(3),
  payload: { metric: 'host_net_error', value: 7, dimensions: { host: 'host-9' } },
  callback_id: 'cb-repeat-777',
};
const first = post(cbPayload);
const second = post(cbPayload);
console.log('重复回调校验：', first.duplicate === false && second.duplicate === true && first.alert.id === second.alert.id
  ? 'PASS（第二次返回首次结果，无副作用）' : 'FAIL');

// ---------- 场景 7b：同一 event_id 重复上报（不同回调，标记 duplicate 但仍走管线合并） ----------
post({
  event_id: 'q-002', event_type: 'data_quality', status: 'firing', event_time: at(2.5),
  payload: { metric: 'null_rate', value: 0.22, threshold: 0.05, dimensions: { table: 'orders', region: 'cn' } },
}); // duplicate=true（同 event_id 第二次），仍并入合并告警

// ---------- 场景 8：规则变更只影响新事件 ----------
const { updateRule } = await import('../src/rules.js');
updateRule(qualityRule.id, {
  name: '数据质量-空值率(收紧)',
  event_type: 'data_quality',
  match: [{ path: 'metric', op: 'eq', value: 'null_rate' }],
  merge_key_template: 'null_rate_v2:{dimensions.table}:{dimensions.region}',
  escalations: [
    { after_minutes: 2, severity: 'major' },
    { after_minutes: 8, severity: 'critical' },
  ],
}); // v2：merge_key 变化 → 新事件不会并入 v1 老告警
post({
  event_id: 'q-201', event_type: 'data_quality', status: 'firing', event_time: at(9),
  payload: { metric: 'null_rate', value: 0.3, dimensions: { table: 'orders', region: 'cn' } },
}); // 生成 v2 新告警；v1 告警仍按 v1 升级链运行

// ---------- 场景 9：父子自动关闭（先于升级 tick，模拟真实持续运行） ----------
post({
  event_id: 'l-001-r', event_type: 'latency', status: 'resolved', event_time: at(10),
  payload: { metric: 'p99_latency', dimensions: { service: 'pay-svc', host: 'host-7' } },
});
post({
  event_id: 'l-002-r', event_type: 'latency', status: 'resolved', event_time: at(11),
  payload: { metric: 'p95_latency', dimensions: { service: 'order-svc', host: 'host-7' } },
}); // 两个子告警闭环，但父告警自身事件未修复 → 父仍 firing
post({
  event_id: 'h-001-r', event_type: 'latency', status: 'resolved', event_time: at(12),
  payload: { metric: 'host_net_error', dimensions: { host: 'host-7' } },
}); // 父自身修复 + 子全部闭环 → 父自动 resolved

// ---------- 场景 10：推进升级（以事件时间为基准，确定性） ----------
// tick@6：v1 质量告警最近事件在 minute 3，仅过 3 分钟，不到 5 分钟阈值 → 0
const tick1 = engine.runEscalations(at(6));
// tick@20（仍打开的告警），单次 tick 允许跨级跳（L1+L2 连升）：
//   质量 v1 orders/cn、orders/us（最近 m3，过 17m）：各连跳 L1 major → L2 critical（4 条记录）
//   业务 v1 告警已人工确认 → 不升级；误报告警 → 不升级
//   v2 告警（最近 m9，过 11m）：连跳 L1 major → L2 critical（2 条记录）
//   host-9（最近 m3，过 17m）→ 未到 20 分钟阈值，不升级
const tick2 = engine.runEscalations(at(20));
console.log('升级触发数 @6min:', tick1.escalated.length, '(期望 0) @20min:', tick2.escalated.length, '(期望 6，跨级连跳)');

const parentFinal = engine.listAlerts().find((a) => a.merge_key === 'host:host-7');
console.log('父子自动关闭校验：', parentFinal.status === 'resolved'
  ? `PASS（父告警 ${parentFinal.id} 随子告警全部闭环而自动关闭）` : 'FAIL');

// 人工反馈保护断言
const ackAlert = engine.listAlerts().find((a) => a.merge_key === 'pay:alipay');
const fpAlertFinal = engine.listAlerts().find((a) => a.merge_key === 'pay:wechat');
const ackDetail = engine.getAlertDetail(ackAlert.id);
const fpDetail = engine.getAlertDetail(fpAlertFinal.id);
console.log('人工确认不被覆盖：', ackAlert.status === 'acknowledged' && ackDetail.feedback.length === 1
  ? 'PASS（修复事件到达后仍为 acknowledged，反馈保留）' : 'FAIL');
console.log('误报反馈不被覆盖：', fpAlertFinal.status === 'false_positive' && fpDetail.feedback.length === 1
  ? 'PASS（后续 firing 事件未重开误报告警）' : 'FAIL');
console.log('反馈 append-only：', ackDetail.feedback[0].kind === 'acknowledge'
  ? `PASS（反馈记录 ${engine.getStats().feedback_total} 条，无删除/改写路径）` : 'FAIL');

// 规则版本断言：v1 老告警与 v2 新告警并存，各按各的版本运行
const v1Alerts = engine.listAlerts({ rule_id: qualityRule.id }).filter((a) => a.rule_version === 1);
const v2Alerts = engine.listAlerts({ rule_id: qualityRule.id }).filter((a) => a.rule_version === 2);
console.log('规则变更只影响新事件：', v1Alerts.length >= 2 && v2Alerts.length === 1
  ? `PASS（v1 告警 ${v1Alerts.length} 条保持旧合并键/升级链，v2 新告警 ${v2Alerts.length} 条）` : 'FAIL');

// 乱序与重复统计
const stats0 = engine.getStats();
console.log('乱序/重复事件：',
  `out_of_order=${stats0.out_of_order} 条，同 event_id 重复=${stats0.duplicate_events} 条，回调幂等=${stats0.callback_events} 条`);

console.log('\n种子数据完成：');
const stats = engine.getStats();
console.log(JSON.stringify(stats, null, 2));
closeDb();
