// 通用工具：ID、时间、模板渲染、对象路径取值
import crypto from 'node:crypto';

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// 按点路径取嵌套值，例如 getPath(e, "dimensions.region")
export function getPath(obj, path) {
  if (obj == null) return undefined;
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// 渲染 "xxx:{dimensions.region}:{metric}" 形式的模板
export function renderTemplate(tpl, ctx) {
  if (!tpl) return '';
  return tpl.replace(/\{([^}]+)\}/g, (_, path) => {
    const v = getPath(ctx, path.trim());
    return v === undefined || v === null ? '∅' : String(v);
  });
}

export function parseJsonArray(v, fallback = []) {
  if (v == null || v === '') return fallback;
  const out = JSON.parse(v);
  if (!Array.isArray(out)) throw new Error('期望 JSON 数组');
  return out;
}

export function parseJsonObject(v, fallback = {}) {
  if (v == null || v === '') return fallback;
  const out = JSON.parse(v);
  if (typeof out !== 'object' || out === null || Array.isArray(out)) {
    throw new Error('期望 JSON 对象');
  }
  return out;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const SEVERITY_ORDER = ['info', 'warning', 'major', 'critical'];
