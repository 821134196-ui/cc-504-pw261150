/* 数据告警中心前端：原生 JS，无依赖、无构建 */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STATUS_META = {
  firing:         { ico: '●', label: '触发中' },
  acknowledged:   { ico: '⚑', label: '已确认' },
  resolved:       { ico: '✓', label: '已关闭' },
  false_positive: { ico: '⚡', label: '误报' },
};
const SEVERITY_META = {
  info:     { ico: 'ℹ', label: 'info' },
  warning:  { ico: '▲', label: 'warning' },
  major:    { ico: '◆', label: 'major' },
  critical: { ico: '■', label: 'critical' },
};
const TIMELINE_ICO = {
  created: '🟦', deduplicated: '🔁', reopened: '↩️', escalated: '⏫',
  resolved: '✅', acknowledged: '⚑', false_positive: '⚡', comment: '💬',
  linked: '🔗', child_attached: '🧩', feedback_protected: '🛡️',
  waiting_children: '⏳', event: '📎', auto_close_skipped: '🔒',
};

let selectedAlertId = null;
let lastAlerts = [];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
}

function statusBadge(status) {
  const m = STATUS_META[status] ?? { ico: '?', label: status };
  return `<span class="badge ${esc(status)}"><span class="ico">${m.ico}</span>${esc(m.label)}</span>`;
}
function severityBadge(sev) {
  const m = SEVERITY_META[sev] ?? { ico: '?', label: sev };
  return `<span class="badge ${esc(sev)}"><span class="ico">${m.ico}</span>${esc(m.label)}</span>`;
}

/* ---------------- Tabs ---------------- */
$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${tab.dataset.tab}`));
  if (tab.dataset.tab === 'events') loadEvents();
  if (tab.dataset.tab === 'rules') loadRules();
}));

/* ---------------- 顶部 KPI ---------------- */
async function loadStats() {
  const s = await api('/api/stats');
  const counts = s.alerts_by_status;
  const tiles = [
    { n: counts.firing ?? 0, l: '触发中' },
    { n: counts.acknowledged ?? 0, l: '已确认' },
    { n: counts.resolved ?? 0, l: '已关闭' },
    { n: counts.false_positive ?? 0, l: '误报' },
    { n: s.out_of_order ?? 0, l: '乱序事件' },
    { n: s.duplicate_events ?? 0, l: '重复事件' },
  ];
  $('#topStats').innerHTML = tiles.map((t) =>
    `<div class="kpi"><div class="num tabular">${t.n}</div><div class="lbl">${t.l}</div></div>`).join('');
}

/* ---------------- 告警列表 ---------------- */
async function loadAlerts() {
  const params = new URLSearchParams();
  const st = $('#filterStatus').value;
  const sv = $('#filterSeverity').value;
  if (st) params.set('status', st);
  if (sv) params.set('severity', sv);
  lastAlerts = await api(`/api/alerts?${params}`);
  const tbody = $('#alertTable tbody');
  if (!lastAlerts.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无告警</td></tr>';
    return;
  }
  tbody.innerHTML = lastAlerts.map((a) => `
    <tr data-id="${a.id}" class="${a.id === selectedAlertId ? 'selected' : ''}">
      <td>
        <div><b>${esc(a.title)}</b></div>
        <div class="dim mono">${esc(a.merge_key)}</div>
        <div class="dim">规则 v${a.rule_version} · ${esc(a.event_type)}</div>
      </td>
      <td>${severityBadge(a.severity)}${a.current_escalation ? ` <span class="tag">L${a.current_escalation}</span>` : ''}</td>
      <td>${statusBadge(a.status)}</td>
      <td class="tabular">×${a.dedupe_count} ${a.children ? `<span class="tag">子 ${a.children}</span>` : ''}</td>
      <td class="dim tabular" title="首次 ${esc(fmtTime(a.first_event_time))}">${esc(fmtTime(a.last_event_time))}</td>
      <td>${a.parent_id ? '<span class="tag">子</span>' : ''}</td>
    </tr>`).join('');
  $$('#alertTable tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    selectedAlertId = tr.dataset.id;
    $$('#alertTable tbody tr').forEach((x) => x.classList.toggle('selected', x === tr));
    loadAlertDetail();
  }));
}

/* ---------------- 告警详情 ---------------- */
function escalationChain(alert, rule) {
  const chain = rule.escalations ?? [];
  const nodes = [`
    <div class="chain-node ${alert.current_escalation === 0 ? 'reached' : ''}">
      <div class="lv">L0 · 初始</div><div class="th">0 分钟 · ${esc(SEVERITY_META.warning.label)}</div>
    </div>`];
  chain.forEach((e, i) => {
    const level = i + 1;
    nodes.push(`<div class="chain-arrow">→</div>
      <div class="chain-node ${alert.current_escalation >= level ? 'reached' : ''}">
        <div class="lv">L${level} · ${esc(e.severity)}</div>
        <div class="th">${e.after_minutes} 分钟${esc(e.label ? ` · ${e.label}` : '')}</div>
      </div>`);
  });
  return `<div class="chain">${nodes.join('')}</div>`;
}

function timelineItem(tl) {
  const sevClass = tl.event_type === 'resolved' ? 'sev-good'
    : tl.event_type === 'escalated' && tl.to_value === 'critical' ? 'sev-critical'
    : tl.event_type === 'escalated' ? 'sev-major'
    : tl.event_type === 'feedback_protected' ? 'sev-info' : '';
  const ico = TIMELINE_ICO[tl.event_type] ?? '•';
  return `<li class="${sevClass}">
    <div class="tl-title">${ico} ${esc(tl.title)}</div>
    <div class="tl-time">事件时间 ${esc(fmtTime(tl.event_time))} · 记录于 ${esc(fmtTime(tl.recorded_at))}${tl.actor ? ` · ${esc(tl.actor)}` : ''}</div>
    ${tl.detail ? `<div class="tl-detail">${esc(tl.detail)}</div>` : ''}
  </li>`;
}

async function loadAlertDetail() {
  if (!selectedAlertId) return;
  let d;
  try { d = await api(`/api/alerts/${selectedAlertId}`); }
  catch (e) { $('#alertDetail').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }

  const feedbackHtml = d.feedback.length ? d.feedback.map((f) => `
    <div class="feedback-card ${esc(f.kind)}">
      <div class="feedback-meta">${esc(STATUS_META[f.kind]?.label ?? f.kind)} · ${esc(f.operator)} · ${esc(fmtTime(f.recorded_at))}</div>
      <div>${esc(f.comment ?? '（无备注）')}</div>
    </div>`).join('') : '<p class="dim">暂无人工反馈</p>';

  const evidenceRows = d.events.map((e) => `
    <tr>
      <td class="mono">${esc(e.event_id)}</td>
      <td><span class="tag">${esc(e.status)}</span>
          ${e.out_of_order ? '<span class="tag ooo">乱序</span>' : ''}
          ${e.duplicate ? '<span class="tag dup">重复</span>' : ''}</td>
      <td class="dim tabular">${esc(fmtTime(e.event_time))}</td>
      <td class="mono dim">${esc(JSON.stringify(e.payload))}</td>
    </tr>`).join('');

  const parentHtml = d.parent ? `
    <div class="tree">
      <div class="node" data-jump="${d.parent.id}">⬆ ${esc(d.parent.title)} ${statusBadge(d.parent.status)}</div>
      <div class="child">
        <div class="node"><b>${esc(d.title)}</b>（当前）</div>
      </div>
    </div>` : '';
  const childrenHtml = d.children.length ? `
    <div class="tree">${d.children.map((c) =>
      `<div class="node" data-jump="${c.id}">🧩 ${esc(c.title)} ${statusBadge(c.status)} ${severityBadge(c.severity)}</div>`).join('')}</div>` : '';

  $('#alertDetail').innerHTML = `
    <div class="detail-head">
      <h2>${esc(d.title)}</h2>
      <div>${severityBadge(d.severity)} ${statusBadge(d.status)}
        ${d.current_escalation ? `<span class="tag">升级 L${d.current_escalation}</span>` : ''}
        <span class="tag mono">${esc(d.id)}</span></div>
      <div class="detail-meta">
        <span>合并键 <b class="mono">${esc(d.merge_key)}</b></span>
        <span>合并次数 <b>${d.dedupe_count}</b></span>
        <span>规则 <b>${esc(d.rule_snapshot.name)} v${d.rule_version}</b></span>
        <span>首次事件 <b>${esc(fmtTime(d.first_event_time))}</b></span>
        <span>最近事件 <b>${esc(fmtTime(d.last_event_time))}</b></span>
        ${d.resolved_at ? `<span>关闭于 <b>${esc(fmtTime(d.resolved_at))}</b> · ${esc(d.closed_by ?? '')}</span>` : ''}
      </div>
    </div>

    <div class="section">
      <h3>升级链路（按规则 v${d.rule_version} 快照执行）</h3>
      ${escalationChain(d, d.rule_snapshot)}
    </div>

    ${(parentHtml || childrenHtml) ? `<div class="section"><h3>父子关系</h3>${parentHtml}${childrenHtml}</div>` : ''}

    <div class="section">
      <h3>证据事件（${d.events.length}）</h3>
      <table class="table"><thead><tr><th>event_id</th><th>状态/标记</th><th>事件时间</th><th>payload</th></tr></thead>
      <tbody>${evidenceRows || '<tr><td colspan="4" class="empty">无</td></tr>'}</tbody></table>
    </div>

    <div class="section">
      <h3>时间线（${d.timeline.length}）— 含合并、升级、反馈保护记录</h3>
      <ul class="timeline">${d.timeline.map(timelineItem).join('')}</ul>
    </div>

    <div class="section">
      <h3>人工反馈（append-only，自动流程不可覆盖）</h3>
      ${feedbackHtml}
      <form class="feedback-form" id="feedbackForm">
        <textarea name="comment" rows="2" placeholder="反馈备注（可选）"></textarea>
        <div class="feedback-row">
          <input type="text" name="operator" placeholder="操作人" value="oncall" required />
          <button class="btn small" type="submit" data-kind="acknowledge">⚑ 人工确认</button>
          <button class="btn small" type="submit" data-kind="false_positive">⚡ 标记误报</button>
          <button class="btn small ghost" type="submit" data-kind="comment">💬 仅加备注</button>
        </div>
      </form>
    </div>`;

  $$('#alertDetail [data-jump]').forEach((el) => el.addEventListener('click', () => {
    selectedAlertId = el.dataset.jump;
    loadAlerts().then(loadAlertDetail);
  }));

  $('#feedbackForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const kind = ev.submitter.dataset.kind;
    try {
      await api(`/api/alerts/${d.id}/feedback`, {
        method: 'POST',
        body: { kind, operator: form.operator.value || 'oncall', comment: form.comment.value },
      });
      toast('反馈已记录（append-only）');
      await Promise.all([loadStats(), loadAlerts(), loadAlertDetail()]);
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------------- 事件流 ---------------- */
async function loadEvents() {
  const params = new URLSearchParams();
  const type = $('#eventTypeFilter').value;
  if (type) params.set('event_type', type);
  if ($('#onlyOutOfOrder').checked) params.set('out_of_order', '1');
  const events = await api(`/api/events?${params}`);
  $('#eventTable tbody').innerHTML = events.length ? events.map((e) => `
    <tr>
      <td class="mono">${esc(e.event_id)}${e.callback_id ? `<div class="dim">cb: ${esc(e.callback_id)}</div>` : ''}</td>
      <td><span class="tag">${esc(e.event_type)}</span></td>
      <td><span class="tag">${esc(e.status)}</span></td>
      <td class="tabular ${e.out_of_order ? '' : ''}">${esc(fmtTime(e.event_time))}</td>
      <td class="dim tabular">${esc(fmtTime(e.received_at))}</td>
      <td>${e.out_of_order ? '<span class="tag ooo">乱序</span>' : ''} ${e.duplicate ? '<span class="tag dup">重复</span>' : ''}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">暂无事件</td></tr>';
}

/* ---------------- 规则与版本 ---------------- */
async function loadRules() {
  const rules = await api('/api/rules');
  $('#rulesPanel').innerHTML = (await Promise.all(rules.map(async (r) => {
    const versions = await api(`/api/rules/${r.id}/versions`);
    const vTags = versions.map((v) =>
      `<span class="vtag ${v.version === r.current_version ? 'current' : ''}">v${v.version}${v.version === r.current_version ? ' · 当前' : ''}</span>`).join('');
    return `<div class="rule-card">
      <h3>${esc(r.name)} ${r.enabled ? '<span class="tag">启用</span>' : '<span class="tag ooo">停用</span>'}</h3>
      <div class="dim">事件类型 ${esc(r.event_type)} · 规则 ID <span class="mono">${esc(r.id)}</span></div>
      <div class="rule-grid">
        <div class="cell"><div class="k">合并键模板</div><div class="v mono">${esc(r.merge_key_template)}</div></div>
        <div class="cell"><div class="k">父子键模板</div><div class="v mono">${esc(r.parent_key_template || '—')}</div></div>
        <div class="cell"><div class="k">匹配条件</div><div class="v mono">${esc(r.match.map((m) => `${m.path} ${m.op ?? 'eq'} ${JSON.stringify(m.value)}`).join(' AND ') || '（全匹配）')}</div></div>
        <div class="cell"><div class="k">升级链</div><div class="v">${r.escalations.map((e) => `${e.after_minutes}min→${e.severity}`).join('，') || '—'}</div></div>
      </div>
      <div class="versions">不可变版本快照（规则变更只影响新事件）：${vTags}</div>
    </div>`;
  }))).join('') || '<p class="empty">暂无规则</p>';
}

/* ---------------- 接入调试 ---------------- */
const SAMPLE = {
  event_id: 'demo-001',
  event_type: 'data_quality',
  status: 'firing',
  event_time: new Date().toISOString(),
  callback_id: 'cb-demo-001',
  payload: {
    metric: 'null_rate', value: 0.18, threshold: 0.05,
    dimensions: { table: 'orders', region: 'cn' },
  },
};
$('#ingestPayload').value = JSON.stringify(SAMPLE, null, 2);

$('#btnSend').addEventListener('click', async () => {
  try {
    const body = JSON.parse($('#ingestPayload').value);
    const data = await api('/api/events', { method: 'POST', body });
    $('#ingestResponse').textContent = JSON.stringify(data, null, 2);
    toast(data.duplicate ? '重复回调（幂等返回，无副作用）' : '事件已接收');
    await Promise.all([loadStats(), loadAlerts()]);
  } catch (e) {
    $('#ingestResponse').textContent = `错误：${e.message}`;
    toast(e.message, true);
  }
});

/* ---------------- 全局控件与轮询 ---------------- */
$('#btnRefresh').addEventListener('click', () => loadStats().then(loadAlerts));
$('#btnRefreshEvents').addEventListener('click', loadEvents);
$('#filterStatus').addEventListener('change', loadAlerts);
$('#filterSeverity').addEventListener('change', loadAlerts);
$('#eventTypeFilter').addEventListener('change', loadEvents);
$('#onlyOutOfOrder').addEventListener('change', loadEvents);
$('#btnTick').addEventListener('click', async () => {
  try {
    const r = await api('/api/escalations/tick', { method: 'POST', body: {} });
    toast(`升级 tick 完成：${r.escalated.length} 条告警升级（基准 ${fmtTime(r.reference_time)}）`);
    await Promise.all([loadStats(), loadAlerts(), selectedAlertId ? loadAlertDetail() : Promise.resolve()]);
  } catch (e) { toast(e.message, true); }
});

async function bootstrap() {
  await loadStats();
  await loadAlerts();
  // 轻量轮询，方便观察后台 ticker 与新事件
  setInterval(() => { loadStats(); loadAlerts(); }, 5000);
}
bootstrap();
