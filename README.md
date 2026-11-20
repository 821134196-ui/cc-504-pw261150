# 数据告警中心（Alert Center）

接收**数据质量、延迟、业务异常**三类事件，按规则合并重复告警、维护父子关系、按时间升级；
事件修复后自动关闭相关告警，**人工确认与误报反馈不可被自动流程覆盖**，规则变更只影响新事件。

零外部运行时依赖：Node.js ≥ 22.5（使用内置 `node:sqlite`、`node:http`、`node:test`）+ 原生前端。

## 快速开始

```bash
npm run seed     # 写入覆盖全部语义的演示数据（重置 data/alert-center.db）
npm start        # 启动服务，默认 http://localhost:4099
npm test         # 运行 28 个后端/接口测试
```

环境变量：`PORT`（默认 4099）、`ALERT_DB`（默认 data/alert-center.db）、`TICK_MS`（后台升级扫描间隔，默认 2000ms）。

## 核心语义

### 1. 事件接入与幂等
- `POST /api/events` 接收事件，`event_id / event_type / status(firing|resolved) / event_time / payload`。
- **回调幂等**：携带相同 `callback_id` 的重复请求原样返回首次结果，零副作用（数据库 `idempotency_key` UNIQUE 约束 + `BEGIN IMMEDIATE` 事务，并发安全）。
- 无 `callback_id` 时按 `event_id + status + event_time` 幂等；同一 `event_id` 再次上报标记 `duplicate=true` 但仍走处理管线。
- **乱序事件**：按事件类型维护 event_time 水位，迟到事件标记 `out_of_order=true`，并入既有告警作为迟到证据，且不回拨告警的 `last_event_time`（升级计时不被污染）。

### 2. 规则匹配与版本化
- 规则含 `match`（支持 eq/neq/gt/gte/lt/lte/in/contains/exists）、`merge_key_template`、可选 `parent_key_template`、`escalations` 升级链。
- 每次内容变更产生**不可变版本快照**（`rule_versions` 表）；启用/停用不产生新版本。
- 事件按**入站时的当前版本**匹配，告警永久快照其创建时的版本（含合并键与升级链）。**规则变更只影响新事件，存量告警按旧版本继续运行。**

### 3. 告警合并（去重）
- 同规则、同版本、同渲染合并键的打开告警只保留一条，重复 firing 事件累加 `dedupe_count` 并追加证据与时间线。
- 已 `resolved` 的告警再次触发会**重开**（同一告警，历史时间线/反馈完整保留）。

### 4. 父子关系
- 子规则通过 `parent_key_template` 渲染父键，自动挂载到 merge_key 相等的父告警（双向时间线记录）。
- 父告警自身修复但仍有子告警未闭环时进入等待；**最后一个子告警闭环后级联自动关闭父告警**。
- 父告警已人工确认时，即使全部闭环也不自动改状态，仅记录 `auto_close_skipped`。

### 5. 时间升级
- 升级链 `after_minutes` 必须严格递增；新告警从 warning 起步，到阈值自动提升 severity/级别。
- 以**事件时间**为基准（`reference = MAX(event_time)`），乱序/历史数据可确定性复现；支持手动 `POST /api/escalations/tick`（可带 `reference_time`）。
- 单次 tick 允许跨级连跳；`acknowledged / false_positive / resolved` 告警不参与升级。

### 6. 修复自动关闭与反馈保护
- resolved 事件自动关闭对应 firing 告警（`closed_by=system`）。
- 人工反馈写入 append-only 的 `alert_feedback` 表，**没有任何更新/删除路径**：
  - `acknowledge`：告警进入确认态，后续 firing/resolved 事件只并入计数并记 `feedback_protected`，状态与反馈不变，且升级冻结。
  - `false_positive`：误报态永久保留，新事件不能重开。
  - `comment`：仅追加备注。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/events` | 事件接入（202，返回 duplicate/out_of_order/alert） |
| GET | `/api/events?event_type=&out_of_order=1` | 事件流查询 |
| GET/POST | `/api/rules` | 规则列表/创建 |
| GET/PUT | `/api/rules/:id` | 规则详情/更新（产生新版本） |
| GET | `/api/rules/:id/versions` | 不可变版本快照列表 |
| GET | `/api/alerts?status=&severity=&rule_id=` | 告警列表（含子告警计数） |
| GET | `/api/alerts/:id` | 告警详情：时间线、证据、升级链、父子、反馈 |
| POST | `/api/alerts/:id/feedback` | 人工反馈 acknowledge/false_positive/comment |
| POST | `/api/escalations/tick` | 手动推进升级（body 可带 `reference_time`） |
| GET | `/api/stats` | KPI 统计与各类型事件水位 |

## 页面（`/`）

- **告警页**：状态/级别过滤、KPI 块；详情含升级链路（L0→Ln 节点）、父子树、证据事件表（乱序/重复标记）、完整时间线、反馈与反馈表单。
- **事件流页**：按类型过滤、只看乱序事件。
- **规则页**：规则配置与全部版本快照标识。
- **接入调试页**：直接编辑 JSON 发送事件并查看响应，便于验证重复回调与乱序。
- 状态色遵循 dataviz 规范：状态/级别一律**图标 + 文字双重编码**，自动适配系统暗色模式。

## 目录结构

```
src/
  db.js       node:sqlite 连接、迁移、事务与 statement 封装
  rules.js    规则 CRUD 与不可变版本快照
  engine.js   核心引擎：匹配/幂等/合并/父子/升级/反馈保护/查询
  server.js   HTTP 路由、静态托管、后台升级 ticker
  util.js     模板渲染、路径取值、ID、错误类型
web/          原生前端（index.html / styles.css / app.js）
tests/        node:test 测试（引擎生命周期 23 例 + HTTP API 5 例）
scripts/seed.js  演示数据与语义自检
```

## 数据模型要点

- `events`：全量事件，含 `idempotency_key(UNIQUE)`、`out_of_order`、`duplicate`、命中的 `rule_id/rule_version/alert_id`。
- `alerts`：告警主表，快照 `rule_version`，维护 `dedupe_count`、`current_escalation`、`parent_id`、单调的首尾事件时间。
- `alert_timeline`：所有状态/合并/升级/关联/保护动作的只追加时间线。
- `alert_feedback`：人工反馈只追加。
- `rule_versions`：规则不可变版本快照。
