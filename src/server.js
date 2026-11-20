// HTTP 服务：REST API + 静态前端托管 + 后台时间升级 ticker
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from './db.js';
import { HttpError } from './util.js';
import { createRule, updateRule, listRules, getRule, listRuleVersions } from './rules.js';
import {
  ingestEvent, runEscalations, addFeedback, listAlerts, getAlertDetail, listEvents, getStats,
} from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 4099);
const TICK_MS = Number(process.env.TICK_MS || 2000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new HttpError(413, '请求体超过 2MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA 回退到 index.html
      fs.readFile(path.join(WEB_DIR, 'index.html'), (e2, html) => {
        if (e2) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

// ---- 路由表 ----
async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // e.g. ['api','alerts']
  const method = req.method;
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};
  const q = url.searchParams;

  // 健康检查
  if (method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }

  // 事件接入
  if (method === 'POST' && url.pathname === '/api/events') {
    return sendJson(res, 202, ingestEvent(body));
  }
  if (method === 'GET' && url.pathname === '/api/events') {
    return sendJson(res, 200, listEvents({
      event_type: q.get('event_type') ?? undefined,
      out_of_order: q.get('out_of_order') ?? undefined,
    }));
  }

  // 升级：手动触发（测试/演示确定性），不传 reference_time 则用事件水位
  if (method === 'POST' && url.pathname === '/api/escalations/tick') {
    return sendJson(res, 200, runEscalations(body.reference_time ?? undefined));
  }

  // 统计
  if (method === 'GET' && url.pathname === '/api/stats') {
    return sendJson(res, 200, getStats());
  }

  // 规则
  if (method === 'GET' && url.pathname === '/api/rules') return sendJson(res, 200, listRules());
  if (method === 'POST' && url.pathname === '/api/rules') return sendJson(res, 201, createRule(body));
  if (seg[0] === 'api' && seg[1] === 'rules' && seg[2]) {
    const ruleId = seg[2];
    if (method === 'GET' && seg[3] === 'versions') return sendJson(res, 200, listRuleVersions(ruleId));
    if (method === 'GET') return sendJson(res, 200, getRule(ruleId));
    if (method === 'PUT' || method === 'PATCH') return sendJson(res, 200, updateRule(ruleId, body));
  }

  // 告警
  if (method === 'GET' && url.pathname === '/api/alerts') {
    return sendJson(res, 200, listAlerts({
      status: q.get('status') ?? undefined,
      severity: q.get('severity') ?? undefined,
      rule_id: q.get('rule_id') ?? undefined,
    }));
  }
  if (seg[0] === 'api' && seg[1] === 'alerts' && seg[2]) {
    const alertId = seg[2];
    if (method === 'GET' && !seg[3]) return sendJson(res, 200, getAlertDetail(alertId));
    if (method === 'POST' && seg[3] === 'feedback') return sendJson(res, 201, addFeedback(alertId, body));
  }

  throw new HttpError(404, `未找到接口：${method} ${url.pathname}`);
}

export async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[server]', err);
    sendJson(res, status, { error: err.message ?? 'internal error' });
  }
}

let ticker = null;
let httpServer = null;

export function start() {
  openDb();
  httpServer = http.createServer(handler);
  httpServer.listen(PORT, () => {
    console.log(`告警中心已启动: http://localhost:${PORT}`);
  });
  // 后台按事件水位推进升级；unref 保证不阻止进程/测试退出
  ticker = setInterval(() => {
    try { runEscalations(); } catch (e) { console.error('[ticker]', e); }
  }, TICK_MS);
  ticker.unref();
  const shutdown = () => stop();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return httpServer;
}

export function stop() {
  if (ticker) { clearInterval(ticker); ticker = null; }
  return new Promise((resolve) => {
    if (httpServer) {
      httpServer.close(() => {
        httpServer = null;
        closeDb();
        resolve();
      });
    } else {
      closeDb();
      resolve();
    }
  });
}

// 直接运行时启动；被测试 import 时不自动监听
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
