# 异步 Ingest 设计

日期：2026-08-04
状态：已批准（草稿）

## 背景

当前 `POST /serve/api/ingest` 同步处理文档入库：解析 → 抽取实体 → 写图（快，毫秒级），有 `llmPath` 时还会跑无头 LLM wiki 会话（Qwen 模型执行 llm-wiki 工作流建 wiki 页面，慢，几分钟）。业务系统需等全部完成才拿到逐文档结果，耗时受慢链路拖累。

目标：ingest 改为异步，提交接口立即返回，业务系统通过新查询接口获取每篇文档的最终结果。

## 决策

1. 提交后立即返回，新增状态/结果查询接口（业务系统轮询）。
2. 每篇文档一个后台任务，提交返回 jobId 数组。
3. 任务状态/结果持久化到图数据库，跨服务重启可查。
4. 采用专用 `IngestJobService`，DB 为唯一事实源，不复用 `BackgroundJob` 内存注册表。

## 数据模型

`KnowledgeGraphStore.migrate()` 新增表：

```sql
CREATE TABLE IF NOT EXISTS kg_ingest_job (
  id TEXT PRIMARY KEY,            -- Identifier.ascending("job")，如 job_xxx
  document_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,        -- CREATE / UPDATE / DELETE
  status TEXT NOT NULL,           -- RUNNING | SUCCESS | FAILED | INTERRUPTED
  entities INTEGER NOT NULL DEFAULT 0,
  relations INTEGER NOT NULL DEFAULT 0,
  summary TEXT,                   -- SUCCESS | SKIPPED（无 llmPath 时为 SKIPPED）
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

### 状态机

- 提交时同步插入一行 `RUNNING` → 后台执行 → `SUCCESS` / `FAILED`。
- 无 `PENDING` 态：fork 即开始执行，语义上等价 `RUNNING`。
- 服务层初始化时把遗留 `RUNNING` 记录更新为 `INTERRUPTED`（重启兜底，幂等）。
- 已完成任务（`SUCCESS`/`FAILED`）结果保留，重启后仍可查询。

## 执行机制

新建 `packages/opencode/src/knowledge/ingest-job.ts`，提供 `IngestJobService`：

- `start(args)` → jobId：
  1. 生成 jobId（`Identifier.ascending("job")`）。
  2. 同步插入 `kg_ingest_job` 行（`RUNNING`）。
  3. 将该文档的完整管线 `Effect.forkIn(实例级 scope)` 丢到后台：DELETE 分支 / 解析 → 抽实体 → 写图 →（有 `llmPath` 时）wiki 会话。结束后更新同一行：`SUCCESS`/`FAILED` + entities/relations/summary/error。
- `get(jobId)` / `list(jobIds)`：读库返回任务行（供查询接口用）。
- 实例级 scope 在 layer 中创建（专用 Scope），请求返回后工作继续执行，生命周期与现有 `BackgroundJob` 一致。
- wiki 会话并发上限：layer 中建 `Semaphore`，仅 `wikiSession.build` 过信号量；快速图操作不限制。默认并发 2，环境变量 `KNOWLEDGE_INGEST_WIKI_CONCURRENCY` 可调，防止多个提交请求叠加打爆 LLM。

`IngestService.ingest` 瘦身为编排：校验身份 → 逐文档 `jobService.start` → 返回 `[{ documentId, jobId, status: "RUNNING" }]`，不再自己跑管线。

## HTTP 契约

### 1. 提交 `POST /serve/api/ingest`（破坏性变更）

请求体不变。响应由逐文档结果改为 jobId 列表，立即返回：

```json
{ "code": 200, "data": [ { "documentId": "10001", "jobId": "job_xxx", "status": "RUNNING" } ] }
```

鉴权不变：无 userId → 401；`IngestForbiddenError` → 403。

### 2. 单查 `GET /serve/api/ingest/jobs/:jobId`

```json
{ "code": 200, "data": {
    "jobId": "job_xxx", "documentId": "10001", "workspaceId": "ws_1", "operation": "CREATE",
    "status": "SUCCESS", "entities": 2, "relations": 1, "summary": "SUCCESS",
    "error": null, "createdAt": "...", "updatedAt": "..." } }
```

未知 jobId → 404。

### 3. 批量查 `GET /serve/api/ingest/jobs?ids=job_1,job_2`

逗号分隔，按传入顺序返回结果数组。一次提交返回 N 个 jobId，业务系统一次拉全批结果。

### 协议层改动（`packages/protocol/src/groups/knowledge.ts`）

- 新增 `IngestJobStatus`（`RUNNING`/`SUCCESS`/`FAILED`/`INTERRUPTED`）。
- 新增 `IngestSubmitItem`、`IngestSubmitResponse`（POST 响应改用此）。
- 新增 `IngestJobResult`、`IngestJobResponse`、`IngestJobListResponse`。
- `KnowledgeIngestGroup` 增加两个 GET 端点。

## 重启兜底

`IngestJobService` 层初始化时执行幂等更新：

```sql
UPDATE kg_ingest_job SET status = 'INTERRUPTED', updated_at = <now>
WHERE status = 'RUNNING'
```

崩溃进程里正在跑的工作随进程消失，但状态准确；业务系统轮询到 `INTERRUPTED` 后可重新提交。

## 测试

沿用现有 `knowledge-ingest.test.ts` + `testEffect` 模式，wiki 会话保持 mock 即时完成：

1. 提交立即返回 jobId 数组（不阻塞）。
2. 轮询直到终态（小重试循环）→ `SUCCESS` + entities/relations/summary 正确。
3. DELETE 走任务 → 轮询 → `SUCCESS`。
4. 抽取器抛错 → 轮询 → `FAILED` + error。
5. 未知 jobId → 404。
6. 批量查询按传入顺序返回。
7. 重启兜底：直接插一行 `RUNNING`，重建层 → 断言被标记 `INTERRUPTED`。

## 影响面

- `packages/opencode/src/knowledge/store.ts`：新增表。
- `packages/opencode/src/knowledge/ingest-job.ts`：新增服务。
- `packages/opencode/src/knowledge/ingest.ts`：瘦身。
- `packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge-ingest.ts`：改用新契约。
- `packages/opencode/src/server/routes/instance/httpapi/groups/knowledge.ts` 与 `packages/protocol/src/groups/knowledge.ts`：协议改动。
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`：注册新服务 layer。
- 测试：`knowledge-ingest.test.ts` 更新 + 新增 `ingest-job.test.ts`。

## 已知限制

- 同一 `llmPath` 目录并发跑多个 wiki 会话可能对 index.md/log.md 产生写竞争。全局信号量（默认 2）已限制整体 LLM 负载；按目录串行作为后续增强，本次不实现。
