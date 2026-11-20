// 测试公共设施：每个用例使用独立临时数据库（复用生产 openDb/migrate）
import fs from 'node:fs';

let counter = 0;

export async function freshEngine() {
  const dbMod = await import('../src/db.js');
  counter += 1;
  const tmp = `data/test-${process.pid}-${counter}.db`;
  const db = dbMod.openDb(tmp);
  const rules = await import('../src/rules.js');
  const engine = await import('../src/engine.js');
  return {
    db, tmp, rules, engine,
    cleanup: () => {
      try { dbMod.closeDb(); } catch { /* ignore */ }
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmp + ext); } catch { /* ignore */ }
      }
    },
  };
}

export const T0 = '2026-11-20T09:00:00.000Z';
export function t(min) {
  return new Date(new Date(T0).getTime() + min * 60000).toISOString();
}

export function qualityRule() {
  return {
    name: '质量规则',
    event_type: 'data_quality',
    match: [{ path: 'metric', op: 'eq', value: 'null_rate' }],
    merge_key_template: 'q:{dimensions.table}:{dimensions.region}',
    escalations: [
      { after_minutes: 5, severity: 'major' },
      { after_minutes: 15, severity: 'critical' },
    ],
  };
}

export function firingEvent(over = {}) {
  return {
    event_id: 'e1',
    event_type: 'data_quality',
    status: 'firing',
    event_time: T0,
    payload: { metric: 'null_rate', value: 0.2, dimensions: { table: 'orders', region: 'cn' } },
    ...over,
  };
}
