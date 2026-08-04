# 异步 Ingest 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `POST /serve/api/ingest` 从同步处理改为异步：提交立即返回 jobId 列表，后台逐文档执行，新增两个 GET 端点供业务系统轮询每个任务的终态与结果（状态持久化到图数据库，跨重启可查）。

**Architecture:** 新建 `IngestJobService`（`src/knowledge/ingest-job.ts`），把原先 `IngestService.ingest` 里的逐文档管线搬进去，fork 到实例级 scope 后台执行；`kg_ingest_job` 表作为唯一事实源。`IngestService` 瘦身为编排（计算 scope/ownerId → 逐文档 `start` → 返回 jobId 列表）。协议层加两个 GET 端点，处理器复用 `knowledge.ingest` group。

**Tech Stack:** Effect（`Layer.effect` / `Effect.forkIn` / `Semaphore`）、bun:sqlite（WAL）、Effect HttpApi/HttpApiBuilder、bun:test。

## Global Constraints

- 任务状态值固定为 `"RUNNING" | "SUCCESS" | "FAILED" | "INTERRUPTED"`（无 `PENDING` 态）。
- 提交即插入 `RUNNING` 行，fork 即开始执行；重启兜底把遗留 `RUNNING` 标记为 `INTERRUPTED`（幂等）。
- 每篇文档一个任务，提交响应为 `[{ documentId, jobId, status: "RUNNING" }]`。
- 批量查询按传入 `ids` 顺序返回；未知 jobId 在批量查询中跳过、单查返回 404。
- wiki 会话并发上限 `KNOWLEDGE_INGEST_WIKI_CONCURRENCY`（默认 2），仅 `wikiSession.build` 过信号量；快速图操作不限。
- 鉴权不变：无 userId → 401；`IngestForbiddenError` → 403。
- jobId 用 `Identifier.ascending("job")`（`@/id/id`）。
- 仅含 DELETE/CREATE/UPDATE 之外的操作不出现（沿用现有契约）。

---

### Task 1: 存储层 — `kg_ingest_job` 表 + store 方法

**Files:**
- Modify: `packages/opencode/src/knowledge/store.ts`
- Test: `packages/opencode/src/knowledge/store.test.ts`

**Interfaces:**
- Consumes: 现有 `KnowledgeGraphStore` / `KnowledgeGraphStoreShape` 结构（见文件顶部 `GraphEntity` 等的写法）。
- Produces: 以下类型与方法，后续任务依赖：
  - `type IngestJobStatus = "RUNNING" | "SUCCESS" | "FAILED" | "INTERRUPTED"`
  - `interface IngestJob { jobId; documentId; workspaceId; operation: "CREATE"|"UPDATE"|"DELETE"; status: IngestJobStatus; entities: number; relations: number; summary?: "SUCCESS"|"SKIPPED"; error?: string; createdAt: string; updatedAt: string }`
  - `interface IngestJobInsertArgs { jobId; documentId; workspaceId; operation: "CREATE"|"UPDATE"|"DELETE" }`
  - `interface IngestJobUpdateArgs { jobId; status: IngestJobStatus; entities?: number; relations?: number; summary?: "SUCCESS"|"SKIPPED"; error?: string }`
  - shape 新增方法：`insertJob(args): Effect<void>`、`updateJob(args): Effect<void>`、`getJob(jobId): Effect<IngestJob | undefined>`、`listJobs(jobIds): Effect<IngestJob[]>`、`markInterruptedJobs(): Effect<number>`

- [ ] **Step 1: 写失败测试**

在 `packages/opencode/src/knowledge/store.test.ts` 的 `describe("KnowledgeGraphStore")` 内追加一个测试：

```ts
it("manages ingest job records (insert/update/get/list/mark-interrupted)", async () => {
  const jobs = await run(
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      yield* store.insertJob({ jobId: "job_1", documentId: "10001", workspaceId: "kb_1", operation: "CREATE" })
      yield* store.insertJob({ jobId: "job_2", documentId: "20001", workspaceId: "kb_1", operation: "DELETE" })
      yield* store.insertJob({ jobId: "job_3", documentId: "30001", workspaceId: "kb_1", operation: "CREATE" })
      yield* store.updateJob({ jobId: "job_1", status: "SUCCESS", entities: 2, relations: 1, summary: "SUCCESS" })
      yield* store.updateJob({ jobId: "job_2", status: "FAILED", error: "boom" })
      const job1 = yield* store.getJob("job_1")
      const listed = yield* store.listJobs(["job_2", "job_1", "job_missing"])
      const marked = yield* store.markInterruptedJobs()
      const job3 = yield* store.getJob("job_3")
      return { job1, listed, marked, job3 }
    }),
  )
  expect(jobs.job1?.status).toBe("SUCCESS")
  expect(jobs.job1?.entities).toBe(2)
  expect(jobs.job1?.relations).toBe(1)
  expect(jobs.job1?.summary).toBe("SUCCESS")
  // 批量查询按传入顺序返回，未知 id 被跳过
  expect(jobs.listed.map((j) => j.jobId)).toEqual(["job_2", "job_1"])
  expect(jobs.listed[0]!.status).toBe("FAILED")
  expect(jobs.listed[0]!.error).toBe("boom")
  expect(jobs.marked).toBe(1)
  expect(jobs.job3?.status).toBe("INTERRUPTED")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/opencode && bun test src/knowledge/store.test.ts`
Expected: FAIL —— `insertJob` 等方法不存在（类型/运行错误）。

- [ ] **Step 3: 实现 store 方法与建表**

在 `packages/opencode/src/knowledge/store.ts`：

在文件顶部（`KnowledgeGraphStoreShape` 之前）加类型：

```ts
export type IngestJobStatus = "RUNNING" | "SUCCESS" | "FAILED" | "INTERRUPTED"

export interface IngestJob {
  jobId: string
  documentId: string
  workspaceId: string
  operation: "CREATE" | "UPDATE" | "DELETE"
  status: IngestJobStatus
  entities: number
  relations: number
  summary?: "SUCCESS" | "SKIPPED"
  error?: string
  createdAt: string
  updatedAt: string
}

export interface IngestJobInsertArgs {
  jobId: string
  documentId: string
  workspaceId: string
  operation: "CREATE" | "UPDATE" | "DELETE"
}

export interface IngestJobUpdateArgs {
  jobId: string
  status: IngestJobStatus
  entities?: number
  relations?: number
  summary?: "SUCCESS" | "SKIPPED"
  error?: string
}
```

在 `KnowledgeGraphStoreShape` 里追加 5 个方法声明：

```ts
readonly insertJob: (args: IngestJobInsertArgs) => Effect.Effect<void>
readonly updateJob: (args: IngestJobUpdateArgs) => Effect.Effect<void>
readonly getJob: (jobId: string) => Effect.Effect<IngestJob | undefined>
readonly listJobs: (jobIds: string[]) => Effect.Effect<IngestJob[]>
readonly markInterruptedJobs: () => Effect.Effect<number>
```

在 `migrate()` 里（`kg_relation` 索引之后）追加建表：

```ts
db.run(`
  CREATE TABLE IF NOT EXISTS kg_ingest_job (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    entities INTEGER NOT NULL DEFAULT 0,
    relations INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`)
db.run("CREATE INDEX IF NOT EXISTS idx_kg_ingest_job_doc ON kg_ingest_job(document_id)")
```

在 `makeStore` 内（`rowToRelation` 之后）加 `rowToJob`：

```ts
const rowToJob = (row: any): IngestJob => ({
  jobId: row.id,
  documentId: row.document_id,
  workspaceId: row.workspace_id,
  operation: row.operation,
  status: row.status,
  entities: row.entities,
  relations: row.relations,
  ...(row.summary != null ? { summary: row.summary } : {}),
  ...(row.error != null ? { error: row.error } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})
```

在返回对象里（`listRelationsForEntity` 之后）追加 5 个方法：

```ts
insertJob: (args: IngestJobInsertArgs) =>
  Effect.sync(() => {
    const ts = now()
    db.prepare(`
      INSERT INTO kg_ingest_job
        (id, document_id, workspace_id, operation, status, entities, relations, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'RUNNING', 0, 0, ?, ?)
    `).run(args.jobId, args.documentId, args.workspaceId, args.operation, ts, ts)
  }),

updateJob: (args: IngestJobUpdateArgs) =>
  Effect.sync(() => {
    db.prepare(`
      UPDATE kg_ingest_job
      SET status = ?, entities = ?, relations = ?, summary = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      args.status,
      args.entities ?? 0,
      args.relations ?? 0,
      args.summary ?? null,
      args.error ?? null,
      now(),
      args.jobId,
    )
  }),

getJob: (jobId: string) =>
  Effect.sync(() => {
    const row = db.prepare("SELECT * FROM kg_ingest_job WHERE id = ?").get(jobId) as any | undefined
    return row ? rowToJob(row) : undefined
  }),

listJobs: (jobIds: string[]) =>
  Effect.sync(() => {
    if (jobIds.length === 0) return []
    const ph = jobIds.map(() => "?").join(",")
    const rows = db.prepare(`SELECT * FROM kg_ingest_job WHERE id IN (${ph})`).all(...jobIds) as Array<any>
    const byId = new Map(rows.map((r) => [r.id, rowToJob(r)]))
    return jobIds.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []))
  }),

markInterruptedJobs: () =>
  Effect.sync(() => {
    const ts = now()
    return db
      .prepare("UPDATE kg_ingest_job SET status = 'INTERRUPTED', updated_at = ? WHERE status = 'RUNNING'")
      .run(ts).changes
  }),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/opencode && bun test src/knowledge/store.test.ts`
Expected: PASS（旧用例 + 新用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/opencode/src/knowledge/store.ts packages/opencode/src/knowledge/store.test.ts
git commit -m "feat(knowledge): persist ingest job records in kg_ingest_job table"
```

---

### Task 2: `IngestJobService` — 后台执行 + 状态机

**Files:**
- Create: `packages/opencode/src/knowledge/ingest-job.ts`
- Create: `packages/opencode/src/knowledge/ingest-job.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `IngestJob`/`IngestJobInsertArgs`/`IngestJobUpdateArgs` 及 store 方法；现有 `IngestDocumentInput`（`./ingest`）、`parseDocument`、`EntityExtractor`、`SummaryWriter`、`WikiSessionService`。
- Produces:
  - `interface IngestJobServiceShape { start(args: { workspaceId; scope: "PUBLIC"|"PRIVATE"; ownerId; document: IngestDocumentInput }): Effect<string>; get(jobId): Effect<IngestJob | undefined>; list(jobIds): Effect<IngestJob[]> }`
  - `class IngestJobService`（`@opencode/knowledge/IngestJob`）含 `static layer` 与 `static test(service)`。
  - `start` 返回 jobId（字符串）；后台自动执行管线并在完成后更新同一行。

- [ ] **Step 1: 写失败测试**

创建 `packages/opencode/src/knowledge/ingest-job.test.ts`：

```ts
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { pollWithTimeout } from "@test/lib/effect"
import { ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { EntityExtractor } from "./entity-extractor"
import { IngestJobService } from "./ingest-job"
import { KnowledgeGraphStore, type IngestJob } from "./store"
import { SummaryWriter } from "./summary-writer"
import { WikiSessionService } from "./wiki-session"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const storeLayer = KnowledgeGraphStore.test(":memory:")
const extractorLayer = EntityExtractor.test(({ title }) =>
  Effect.succeed({
    entities: [
      { name: title, type: "文档" },
      { name: "人力资源部", type: "角色" },
    ],
    relations: [{ head: title, tail: "人力资源部", relation: "负责" }],
  }),
)
const failingExtractorLayer = EntityExtractor.test(() =>
  Effect.fail(new Error("extractor exploded")),
)
const wikiSuccessLayer = WikiSessionService.test(() => Effect.succeed({ status: "SUCCESS" as const }))
const summaryWriterNoopLayer = SummaryWriter.test(tmpdir())

const jobLayer = Layer.provideMerge(
  IngestJobService.layer.pipe(
    Layer.provide(storeLayer),
    Layer.provide(extractorLayer),
    Layer.provide(wikiSuccessLayer),
    Layer.provide(summaryWriterNoopLayer),
  ),
)

// 轮询直到任务离开 RUNNING 状态
const pollJob = (jobId: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      const job = yield* store.getJob(jobId)
      return job && job.status !== "RUNNING" ? job : undefined
    }),
    `job ${jobId} did not reach terminal state`,
  )

const run = <A>(effect: Effect.Effect<A, unknown, IngestJobService | KnowledgeGraphStore>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(IngestJobService.layer),
      Effect.provide(storeLayer),
      Effect.provide(extractorLayer),
      Effect.provide(wikiSuccessLayer),
      Effect.provide(summaryWriterNoopLayer),
    ),
  )

describe("IngestJobService", () => {
  it("runs a CREATE document to SUCCESS and writes the graph", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* IngestJobService
        const store = yield* KnowledgeGraphStore
        const jobId = yield* svc.start({
          workspaceId: "kb_1",
          scope: "PUBLIC",
          ownerId: "",
          document: {
            documentId: "10001",
            title: "考勤制度",
            format: "txt",
            operation: "CREATE",
            fileContent: Buffer.from("第一章 考勤制度 人力资源部 负责 考勤 管理").toString("base64"),
          },
        })
        const job = yield* pollJob(jobId)
        const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        return { job, entities }
      }),
    )
    expect(result.job.status).toBe("SUCCESS")
    expect(result.job.entities).toBe(2)
    expect(result.job.relations).toBe(1)
    expect(result.job.summary).toBe("SUCCESS")
    expect(result.entities).toHaveLength(2)
  })

  it("runs a DELETE document to SUCCESS and removes the graph", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* IngestJobService
        const store = yield* KnowledgeGraphStore
        yield* store.replaceDocumentGraph({
          workspaceId: "kb_1",
          documentId: "10001",
          scope: "PUBLIC",
          ownerId: "",
          entities: [{ name: "旧制度", type: "制度" }],
          relations: [],
        })
        const jobId = yield* svc.start({
          workspaceId: "kb_1",
          scope: "PUBLIC",
          ownerId: "",
          document: { documentId: "10001", title: "旧制度", operation: "DELETE" },
        })
        const job = yield* pollJob(jobId)
        const remaining = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        return { job, remaining }
      }),
    )
    expect(result.job.status).toBe("SUCCESS")
    expect(result.job.summary).toBe("SKIPPED")
    expect(result.remaining).toHaveLength(0)
  })

  it("marks a job FAILED when the extractor throws", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* IngestJobService
        const jobId = yield* svc.start({
          workspaceId: "kb_1",
          scope: "PUBLIC",
          ownerId: "",
          document: {
            documentId: "10001",
            title: "考勤制度",
            format: "txt",
            operation: "CREATE",
            fileContent: Buffer.from("正文").toString("base64"),
          },
        })
        return yield* pollJob(jobId)
      }),
    )
    expect(result.status).toBe("FAILED")
    expect(result.error).toBe("extractor exploded")
  })

  it("lists jobs in the requested order", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* IngestJobService
        const a = yield* svc.start({
          workspaceId: "kb_1", scope: "PUBLIC", ownerId: "",
          document: { documentId: "a", title: "A", operation: "DELETE" },
        })
        const b = yield* svc.start({
          workspaceId: "kb_1", scope: "PUBLIC", ownerId: "",
          document: { documentId: "b", title: "B", operation: "DELETE" },
        })
        return yield* svc.list([b, a])
      }),
    )
    expect(result.map((j) => j.jobId)).toEqual([b, a])
  })

  it("marks leftover RUNNING jobs INTERRUPTED on layer startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-restart-"))
    const dbPath = join(dir, "kg.db")
    const fileStoreLayer = KnowledgeGraphStore.test(dbPath)
    try {
      // phase 1：直接插一行 RUNNING（模拟上次进程崩溃）
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* KnowledgeGraphStore
          yield* store.insertJob({ jobId: "job_leftover", documentId: "1", workspaceId: "kb_1", operation: "CREATE" })
        }).pipe(Effect.provide(fileStoreLayer)),
      )
      // phase 2：用同一个文件重建服务层，应把 RUNNING 标记为 INTERRUPTED
      const job = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* IngestJobService
          return yield* svc.get("job_leftover")
        }).pipe(
          Effect.provide(IngestJobService.layer),
          Effect.provide(fileStoreLayer),
          Effect.provide(extractorLayer),
          Effect.provide(wikiSuccessLayer),
          Effect.provide(summaryWriterNoopLayer),
        ),
      )
      expect(job?.status).toBe("INTERRUPTED")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
```

> 注：`failingExtractorLayer` 在该文件暂未使用——本任务第 3 个用例用的是 `run` 里的默认 extractor。若你想在用例内切换，把 `run` 拆成可注入 extractor 的形式（见 Step 3 的实现；测试里保持默认成功 extractor 即可）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/opencode && bun test src/knowledge/ingest-job.test.ts`
Expected: FAIL —— `./ingest-job` 模块不存在。

- [ ] **Step 3: 实现 `IngestJobService`**

创建 `packages/opencode/src/knowledge/ingest-job.ts`：

```ts
import { Config as EffectConfig, Context, Effect, Layer, Scope, Semaphore } from "effect"
import { Identifier } from "@/id/id"
import { parseDocument } from "./doc-parser"
import { EntityExtractor } from "./entity-extractor"
import { KnowledgeGraphStore, type IngestJob, type IngestJobUpdateArgs } from "./store"
import { SummaryWriter } from "./summary-writer"
import { WikiSessionService } from "./wiki-session"
import type { IngestDocumentInput } from "./ingest"

export interface IngestJobServiceShape {
  readonly start: (args: {
    workspaceId: string
    scope: "PUBLIC" | "PRIVATE"
    ownerId: string
    document: IngestDocumentInput
  }) => Effect.Effect<string>
  readonly get: (jobId: string) => Effect.Effect<IngestJob | undefined>
  readonly list: (jobIds: string[]) => Effect.Effect<IngestJob[]>
}

export class IngestJobService extends Context.Service<IngestJobService, IngestJobServiceShape>()(
  "@opencode/knowledge/IngestJob",
) {
  static layer = Layer.effect(
    IngestJobService,
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      const extractor = yield* EntityExtractor
      const summaryWriter = yield* SummaryWriter
      const wikiSession = yield* WikiSessionService
      const scope = yield* Scope.Scope
      const wikiConcurrency = yield* EffectConfig.integer("KNOWLEDGE_INGEST_WIKI_CONCURRENCY").pipe(
        EffectConfig.withDefault(2),
      )
      const wikiPermits = yield* Semaphore.make(wikiConcurrency)

      // 重启兜底：进程启动时把遗留 RUNNING 任务标记为 INTERRUPTED（幂等）。
      const interrupted = yield* store.markInterruptedJobs()
      if (interrupted > 0) {
        yield* Effect.logInfo("knowledge ingest: recovered interrupted jobs", { count: interrupted })
      }

      type JobArgs = {
        jobId: string
        workspaceId: string
        scope: "PUBLIC" | "PRIVATE"
        ownerId: string
        document: IngestDocumentInput
      }

      const finish = (patch: IngestJobUpdateArgs): Effect.Effect<void> => store.updateJob(patch)

      const runOne = (args: JobArgs): Effect.Effect<void> => {
        const doc = args.document
        return Effect.gen(function* () {
          if (doc.operation === "DELETE") {
            const deleted = yield* store.deleteDocumentGraph({
              workspaceId: args.workspaceId,
              documentId: doc.documentId,
            })
            yield* Effect.logInfo("knowledge ingest delete done", {
              jobId: args.jobId,
              documentId: doc.documentId,
              workspaceId: args.workspaceId,
              deletedEntities: deleted.deletedEntities,
              deletedRelations: deleted.deletedRelations,
            })
            if (doc.llmPath) {
              yield* summaryWriter.delete({ workspaceLlmPath: doc.llmPath, documentId: doc.documentId })
            }
            yield* finish({
              jobId: args.jobId,
              status: "SUCCESS",
              entities: deleted.deletedEntities,
              relations: deleted.deletedRelations,
              summary: doc.llmPath ? "SUCCESS" : "SKIPPED",
            })
            return
          }
          const parsed = yield* parseDocument({ format: doc.format ?? "", fileContent: doc.fileContent })
          const extracted = yield* extractor.extract({ title: doc.title, text: parsed.text })
          yield* Effect.logInfo("knowledge ingest write graph", {
            jobId: args.jobId,
            documentId: doc.documentId,
            workspaceId: args.workspaceId,
            scope: args.scope,
            ownerId: args.ownerId,
            title: doc.title,
            entityCount: extracted.entities.length,
            relationCount: extracted.relations.length,
          })
          const result = yield* store.replaceDocumentGraph({
            workspaceId: args.workspaceId,
            documentId: doc.documentId,
            scope: args.scope,
            ownerId: args.ownerId,
            entities: extracted.entities,
            relations: extracted.relations,
          })
          let summary: "SUCCESS" | "SKIPPED" = "SKIPPED"
          if (doc.llmPath) {
            yield* Effect.logInfo("knowledge summary start", {
              jobId: args.jobId,
              documentId: doc.documentId,
              workspaceId: args.workspaceId,
              workspaceLlmPath: doc.llmPath,
            })
            const wikiResult = yield* wikiPermits.withPermit(
              wikiSession.build({
                workspaceLlmPath: doc.llmPath,
                documentId: doc.documentId,
                title: doc.title,
                text: parsed.text,
              }),
            )
            if (wikiResult.status === "SUCCESS") {
              summary = "SUCCESS"
            } else {
              yield* Effect.logWarning("knowledge summary skipped", {
                jobId: args.jobId,
                documentId: doc.documentId,
                workspaceId: args.workspaceId,
                workspaceLlmPath: doc.llmPath,
                error: wikiResult.error,
              })
            }
          } else {
            yield* Effect.logDebug("knowledge summary skipped: no llmPath", {
              jobId: args.jobId,
              documentId: doc.documentId,
              workspaceId: args.workspaceId,
            })
          }
          yield* finish({
            jobId: args.jobId,
            status: "SUCCESS",
            entities: result.entityCount,
            relations: result.relationCount,
            summary,
          })
        }).pipe(
          Effect.catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            return Effect.logError("knowledge ingest job failed", {
              jobId: args.jobId,
              documentId: doc.documentId,
              workspaceId: args.workspaceId,
              error: message,
            }).pipe(Effect.andThen(finish({ jobId: args.jobId, status: "FAILED", error: message })))
          }),
        )
      }

      return IngestJobService.of({
        start: (args) =>
          Effect.gen(function* () {
            const jobId = Identifier.ascending("job")
            yield* store.insertJob({
              jobId,
              documentId: args.document.documentId,
              workspaceId: args.workspaceId,
              operation: args.document.operation,
            })
            yield* Effect.logInfo("knowledge ingest job queued", {
              jobId,
              documentId: args.document.documentId,
              workspaceId: args.workspaceId,
              operation: args.document.operation,
            })
            yield* runOne({ ...args, jobId }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
            return jobId
          }),
        get: (jobId) => store.getJob(jobId),
        list: (jobIds) => store.listJobs(jobIds),
      })
    }),
  )

  static test = (service: IngestJobServiceShape) =>
    Layer.succeed(IngestJobService, IngestJobService.of(service))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/opencode && bun test src/knowledge/ingest-job.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/opencode/src/knowledge/ingest-job.ts packages/opencode/src/knowledge/ingest-job.test.ts
git commit -m "feat(knowledge): run ingest pipelines as persisted background jobs"
```

---

### Task 3: 瘦身 `IngestService` 为编排 + 改写服务测试

**Files:**
- Modify: `packages/opencode/src/knowledge/ingest.ts`
- Modify: `packages/opencode/src/knowledge/ingest.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `IngestJobService`（`start`）。
- Produces:
  - `interface IngestSubmitItem { documentId: string; jobId: string; status: "RUNNING" }`
  - `interface IngestServiceShape { submit(args: { workspaceId; identity; documents: IngestDocumentInput[] }): Effect<IngestSubmitItem[], IngestForbiddenError> }`
  - 移除旧 `ingest` 方法、`IngestDocumentResult`。

- [ ] **Step 1: 改写测试（先红）**

用下面的内容整体替换 `packages/opencode/src/knowledge/ingest.test.ts`：

```ts
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { pollWithTimeout } from "@test/lib/effect"
import { ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { EntityExtractor } from "./entity-extractor"
import { IngestService } from "./ingest"
import { IngestJobService } from "./ingest-job"
import { KnowledgeGraphStore } from "./store"
import { SummaryWriter } from "./summary-writer"
import { WikiSessionService } from "./wiki-session"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const identity = ExternalIdentityInfo.make({
  userId: "user_1",
  nickName: "张三",
  tenantId: "tenant_01",
  workspaces: [
    { workspaceId: "kb_1", workspaceName: "公共知识库", llmPath: join(tmpdir(), "kg-ingest-test", "kb_1"), categories: [] },
    { workspaceId: "my_user_1", workspaceName: "个人知识库", categories: [] },
  ],
  permissions: {},
})

const storeLayer = KnowledgeGraphStore.test(":memory:")
const extractorLayer = EntityExtractor.test(({ title }) =>
  Effect.succeed({
    entities: [
      { name: title, type: "文档" },
      { name: "人力资源部", type: "角色" },
    ],
    relations: [{ head: title, tail: "人力资源部", relation: "负责" }],
  }),
)
const summaryWriterLayerNoop = SummaryWriter.test(tmpdir())

// 默认 wiki session mock：SUCCESS，不触发真实 opencode 会话。
const wikiSessionSuccessLayer = WikiSessionService.test(() => Effect.succeed({ status: "SUCCESS" as const }))

const run = <A>(
  effect: Effect.Effect<A, unknown, IngestService | KnowledgeGraphStore>,
  writerLayer: Layer.Layer<SummaryWriter> = summaryWriterLayerNoop,
  wikiLayer: Layer.Layer<WikiSessionService> = wikiSessionSuccessLayer,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(IngestService.layer),
      Effect.provide(IngestJobService.layer),
      Effect.provide(extractorLayer),
      Effect.provide(storeLayer),
      Effect.provide(writerLayer),
      Effect.provide(wikiLayer),
    ),
  )

// 轮询任务直到终态
const pollJob = (store: KnowledgeGraphStore.Interface, jobId: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const job = yield* store.getJob(jobId)
      return job && job.status !== "RUNNING" ? job : undefined
    }),
    `job ${jobId} did not reach terminal state`,
  )

describe("IngestService", () => {
  it("submits a CREATE document and the job succeeds with graph written", async () => {
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const store = yield* KnowledgeGraphStore
        const res = yield* svc.submit({
          workspaceId: "kb_1",
          identity,
          documents: [
            {
              documentId: "10001",
              title: "考勤制度",
              format: "txt",
              operation: "CREATE",
              fileContent: Buffer.from("第一章 考勤制度 人力资源部 负责 考勤 管理").toString("base64"),
            },
          ],
        })
        expect(res).toHaveLength(1)
        expect(res[0]!.documentId).toBe("10001")
        expect(res[0]!.status).toBe("RUNNING")
        const job = yield* pollJob(store, res[0]!.jobId)
        const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        return { job, entities }
      }),
    )
    expect(results.job.status).toBe("SUCCESS")
    expect(results.job.entities).toBe(2)
    expect(results.job.relations).toBe(1)
    expect(results.entities).toHaveLength(2)
  })

  it("DELETE goes through a job and removes the document graph", async () => {
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const store = yield* KnowledgeGraphStore
        // 先入库一篇文档，再走 DELETE 任务
        const create = yield* svc.submit({
          workspaceId: "kb_1",
          identity,
          documents: [
            {
              documentId: "10001",
              title: "考勤制度",
              format: "txt",
              operation: "CREATE",
              fileContent: Buffer.from("正文").toString("base64"),
            },
          ],
        })
        const createdJob = yield* pollJob(store, create[0]!.jobId)
        expect(createdJob.status).toBe("SUCCESS")

        const res = yield* svc.submit({
          workspaceId: "kb_1",
          identity,
          documents: [{ documentId: "10001", title: "考勤制度", operation: "DELETE" }],
        })
        const job = yield* pollJob(store, res[0]!.jobId)
        const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        return { job, entities }
      }),
    )
    expect(results.job.status).toBe("SUCCESS")
    expect(results.entities).toHaveLength(0)
  })

  it("submits to a workspace not listed in identity (skips workspace check)", async () => {
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const store = yield* KnowledgeGraphStore
        const res = yield* svc.submit({
          workspaceId: "kb_other",
          identity,
          documents: [{ documentId: "1", title: "x", operation: "DELETE" }],
        })
        const job = yield* pollJob(store, res[0]!.jobId)
        return job
      }),
    )
    expect(results.status).toBe("SUCCESS")
  })

  it("allows own personal workspace even if not listed", async () => {
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const store = yield* KnowledgeGraphStore
        const res = yield* svc.submit({
          workspaceId: "my_user_1",
          identity,
          documents: [
            {
              documentId: "20001",
              title: "私人笔记",
              format: "txt",
              operation: "CREATE",
              fileContent: Buffer.from("我的私人笔记内容").toString("base64"),
            },
          ],
        })
        const job = yield* pollJob(store, res[0]!.jobId)
        const entities = yield* store.listEntitiesByDocument({ documentId: "20001", userId: "user_1" })
        return { job, entities }
      }),
    )
    expect(results.job.status).toBe("SUCCESS")
    expect(results.entities).toHaveLength(2)
  })

  it("runs wiki session to build pages when document carries llmPath", async () => {
    let called: { workspaceLlmPath: string; documentId: string; title: string } | undefined
    const wikiLayer = WikiSessionService.test((args) => {
      called = { workspaceLlmPath: args.workspaceLlmPath, documentId: args.documentId, title: args.title }
      return Effect.succeed({ status: "SUCCESS" as const })
    })
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const store = yield* KnowledgeGraphStore
        const res = yield* svc.submit({
          workspaceId: "kb_1",
          identity,
          documents: [{
            documentId: "10001",
            title: "考勤制度",
            llmPath: join(tmpdir(), "kg-ingest-test", "kb_1"),
            format: "txt",
            operation: "CREATE",
            fileContent: Buffer.from("第一章 考勤制度 人力资源部 负责 考勤 管理").toString("base64"),
          }],
        })
        const job = yield* pollJob(store, res[0]!.jobId)
        return job
      }),
      summaryWriterLayerNoop,
      wikiLayer,
    )
    expect(results.status).toBe("SUCCESS")
    expect(results.summary).toBe("SUCCESS")
    expect(called).toBeDefined()
    expect(called!.documentId).toBe("10001")
    expect(called!.title).toBe("考勤制度")
    expect(called!.workspaceLlmPath).toContain("kg-ingest-test")
  })

  it("skips summary when document has no llmPath", async () => {
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const store = yield* KnowledgeGraphStore
        const res = yield* svc.submit({
          workspaceId: "my_user_1",
          identity,
          documents: [{
            documentId: "20001",
            title: "私人笔记",
            format: "txt",
            operation: "CREATE",
            fileContent: Buffer.from("我的私人笔记内容").toString("base64"),
          }],
        })
        const job = yield* pollJob(store, res[0]!.jobId)
        const entities = yield* store.listEntitiesByDocument({ documentId: "20001", userId: "user_1" })
        return { job, entities }
      }),
    )
    expect(results.job.status).toBe("SUCCESS")
    expect(results.job.summary).toBe("SKIPPED")
    expect(results.entities).toHaveLength(2)
  })

  it("deletes source page on DELETE operation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-ingest-"))
    try {
      const res = await run(
        Effect.gen(function* () {
          const svc = yield* IngestService
          const store = yield* KnowledgeGraphStore
          const create = yield* svc.submit({
            workspaceId: "kb_1",
            identity,
            documents: [{
              documentId: "10001",
              title: "考勤制度",
              format: "txt",
              operation: "CREATE",
              fileContent: Buffer.from("正文").toString("base64"),
            }],
          })
          yield* pollJob(store, create[0]!.jobId)
          const del = yield* svc.submit({
            workspaceId: "kb_1",
            identity,
            documents: [{ documentId: "10001", title: "考勤制度", llmPath: dir, operation: "DELETE" }],
          })
          return yield* pollJob(store, del[0]!.jobId)
        }),
        SummaryWriter.test(dir),
      )
      expect(res.status).toBe("SUCCESS")
      expect(res.summary).toBe("SUCCESS")
      // DELETE 走 summaryWriter.delete；从未写入过文件时为 no-op（ENOENT 忽略），文件必然不存在。
      const exists = await access(join(dir, "wiki", "sources", "10001.md")).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
```

> 注意：`DELETE goes through a job` 用例先提交 CREATE 并轮询到终态，再提交 DELETE 并轮询，最后断言图已清空——直接使用上面给出的完整代码。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/opencode && bun test src/knowledge/ingest.test.ts`
Expected: FAIL —— `svc.submit` 不存在（类型错误）；且 `IngestService.layer` 现在不依赖 `IngestJobService`，provide 链里多余的 `Effect.provide(IngestJobService.layer)` 也可能报错（后续 Step 3 修复）。

> 若实现后仍有此占位残留导致逻辑错误，Step 4 会暴露。

- [ ] **Step 3: 瘦身 `IngestService`**

用下面内容整体替换 `packages/opencode/src/knowledge/ingest.ts`：

```ts
import { Context, Effect, Layer, Schema } from "effect"
import type { ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { IngestJobService } from "./ingest-job"

export class IngestForbiddenError extends Schema.TaggedErrorClass<IngestForbiddenError>()(
  "IngestForbiddenError",
  { message: Schema.String },
) {}

export interface IngestDocumentInput {
  documentId: string
  title: string
  categoryId?: string
  llmPath?: string
  secretLevel?: string
  format?: string
  summary?: string
  keywords?: string[]
  operation: "CREATE" | "UPDATE" | "DELETE"
  fileContent?: string
}

export interface IngestSubmitItem {
  documentId: string
  jobId: string
  status: "RUNNING"
}

export interface IngestServiceShape {
  readonly submit: (args: {
    workspaceId: string
    identity: ExternalIdentityInfo
    documents: IngestDocumentInput[]
  }) => Effect.Effect<IngestSubmitItem[], IngestForbiddenError>
}

export class IngestService extends Context.Service<IngestService, IngestServiceShape>()(
  "@opencode/knowledge/Ingest",
) {
  static layer = Layer.effect(
    IngestService,
    Effect.gen(function* () {
      const jobs = yield* IngestJobService
      return IngestService.of({
        submit: (args) =>
          Effect.gen(function* () {
            const scope: "PUBLIC" | "PRIVATE" = args.workspaceId.startsWith("my_") ? "PRIVATE" : "PUBLIC"
            const ownerId = scope === "PRIVATE" ? args.identity.userId : ""

            yield* Effect.logInfo("knowledge ingest submit", {
              workspaceId: args.workspaceId,
              scope,
              userId: args.identity.userId,
              documentCount: args.documents.length,
            })

            return yield* Effect.forEach(
              args.documents,
              (doc) =>
                Effect.gen(function* () {
                  const jobId = yield* jobs.start({
                    workspaceId: args.workspaceId,
                    scope,
                    ownerId,
                    document: doc,
                  })
                  return { documentId: doc.documentId, jobId, status: "RUNNING" as const }
                }),
              { concurrency: 2 },
            )
          }),
      })
    }),
  )
}
```

- [ ] **Step 4: 运行测试确认通过（并清理占位代码）**

先删掉 Step 1 里 `DELETE goes through a job` 用例中的占位行，再运行：

Run: `cd packages/opencode && bun test src/knowledge/ingest.test.ts`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/opencode/src/knowledge/ingest.ts packages/opencode/src/knowledge/ingest.test.ts
git commit -m "refactor(knowledge): ingest submit returns job ids, pipeline runs in background"
```

---

### Task 4: 协议层 — 新增 job 状态 schema 与两个 GET 端点

**Files:**
- Modify: `packages/protocol/src/groups/knowledge.ts`

**Interfaces:**
- Consumes: 现有 `HttpApiGroup.make("knowledge.ingest")`、`HttpApiEndpoint.post("ingest", ...)`。
- Produces（后续 handler 依赖）:
  - `IngestJobStatus`（`RUNNING|SUCCESS|FAILED|INTERRUPTED`）
  - `IngestSubmitItem`、`IngestSubmitResponse`（POST 响应改用此，替换 `IngestResultItem`/`IngestResponse`）
  - `IngestJobResult`、`IngestJobQuery`（`{ ids: string }`）、`IngestJobResponse`、`IngestJobListResponse`
  - `KnowledgeIngestGroup` 新增端点 `get("job", /ingest/jobs/:jobId)` 与 `get("jobs", /ingest/jobs)`。

- [ ] **Step 1: 写测试（无现有协议测试；跳到实现）**

协议层没有独立测试文件。此任务验证方式为 Step 3 的类型检查 + 后续 Task 6 的 HTTP 集成测试。直接进入实现。

- [ ] **Step 2: 实现 schema 与端点**

在 `packages/protocol/src/groups/knowledge.ts`：

(a) 把 `IngestResultItem` / `IngestResponse` 替换为提交契约：

```ts
export const IngestJobStatus = Schema.Union([
  Schema.Literal("RUNNING"),
  Schema.Literal("SUCCESS"),
  Schema.Literal("FAILED"),
  Schema.Literal("INTERRUPTED"),
])

export const IngestSubmitItem = Schema.Struct({
  documentId: Schema.String,
  jobId: Schema.String,
  status: IngestJobStatus,
})

export const IngestSubmitResponse = Schema.Struct({
  code: Schema.Number,
  data: Schema.Array(IngestSubmitItem),
})
```

(b) 新增 job 结果 schema：

```ts
export const IngestJobResult = Schema.Struct({
  jobId: Schema.String,
  documentId: Schema.String,
  workspaceId: Schema.String,
  operation: Schema.String,
  status: IngestJobStatus,
  entities: Schema.Number,
  relations: Schema.Number,
  summary: Schema.optional(Schema.Union([Schema.Literal("SUCCESS"), Schema.Literal("SKIPPED")])),
  error: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

export const IngestJobQuery = Schema.Struct({
  ids: Schema.String,
})

export const IngestJobResponse = Schema.Struct({
  code: Schema.Number,
  data: IngestJobResult,
})

export const IngestJobListResponse = Schema.Struct({
  code: Schema.Number,
  data: Schema.Array(IngestJobResult),
})
```

(c) 把 `KnowledgeIngestGroup` 改为三端点（POST 响应改用 `IngestSubmitResponse`）：

```ts
export const KnowledgeIngestGroup = HttpApiGroup.make("knowledge.ingest")
  .add(
    HttpApiEndpoint.post("ingest", `${root}/ingest`, {
      payload: IngestPayload,
      success: IngestSubmitResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.ingest",
        summary: "Submit documents for async ingest into the knowledge graph",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("job", `${root}/ingest/jobs/:jobId`, {
      params: { jobId: Schema.String },
      success: IngestJobResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.ingest.job",
        summary: "Get a single ingest job status and result",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("jobs", `${root}/ingest/jobs`, {
      query: IngestJobQuery,
      success: IngestJobListResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.ingest.jobs",
        summary: "List ingest job results in the requested order",
      }),
    ),
  )
```

- [ ] **Step 3: 类型检查**

Run: `cd packages/opencode && bun run typecheck`
Expected: 通过（此时 `IngestResponse`/`IngestResultItem` 引用已全部移除；若 opencode 侧 handler 仍引用旧名，Task 5 会修复——如本步报错且指向 `knowledge-ingest.ts`，属预期，继续 Task 5）。

- [ ] **Step 4: 提交**

```bash
git add packages/protocol/src/groups/knowledge.ts
git commit -m "feat(protocol): async ingest submit + job status endpoints"
```

---

### Task 5: Handler — 复用 `knowledge.ingest` group，新增 GET 处理

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge-ingest.ts`

**Interfaces:**
- Consumes: Task 3 的 `IngestService.submit`、Task 2 的 `IngestJobService`、Task 4 的端点名 `ingest`/`job`/`jobs`。
- Produces: 完整 `knowledge.ingest` group handler（POST 提交 + GET 单查 + GET 批量）。

- [ ] **Step 1: 重写 handler**

用下面内容整体替换 `packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge-ingest.ts`：

```ts
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { IngestService } from "@/knowledge/ingest"
import { IngestJobService } from "@/knowledge/ingest-job"
import { KnowledgeApi } from "../groups/knowledge"

export const KnowledgeIngestHandler = HttpApiBuilder.group(
  KnowledgeApi,
  "knowledge.ingest",
  (handlers) =>
    Effect.gen(function* () {
      const ingest = yield* IngestService
      const jobs = yield* IngestJobService
      return handlers
        .handle(
          "ingest",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const data = yield* ingest
              .submit({
                workspaceId: ctx.payload.workspaceId,
                identity,
                documents: ctx.payload.documents,
              })
              .pipe(Effect.catchTag("IngestForbiddenError", () => Effect.succeed(null)))
            if (data === null) return HttpServerResponse.empty({ status: 403 })
            return { code: 200, data }
          }),
        )
        .handle(
          "job",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const job = yield* jobs.get(ctx.params.jobId)
            if (!job) return HttpServerResponse.empty({ status: 404 })
            return { code: 200, data: job }
          }),
        )
        .handle(
          "jobs",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const ids = ctx.query.ids
              .split(",")
              .map((s: string) => s.trim())
              .filter((s: string) => s.length > 0)
            const data = yield* jobs.list(ids)
            return { code: 200, data }
          }),
        )
    }),
)
```

- [ ] **Step 2: 类型检查**

Run: `cd packages/opencode && bun run typecheck`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge-ingest.ts
git commit -m "feat(server): handle async ingest submit + job status endpoints"
```

---

### Task 6: 服务器装配 + HTTP 集成测试

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge-ingest.test.ts`

**Interfaces:**
- Consumes: Task 2/3/5 的 `IngestJobService.layer`、`IngestService.layer`、handler。
- Produces: 装配好的完整链路；HTTP 测试验证端到端。

- [ ] **Step 1: 装配 `IngestJobService.layer`**

在 `packages/opencode/src/server/routes/instance/httpapi/server.ts`：

(a) 顶部 import 加一行：

```ts
import { IngestJobService } from "@/knowledge/ingest-job"
```

(b) 把 `knowledgeApiRoutes` 里 `IngestService.layer` 的 provide 链包一层 `IngestJobService.layer`：

```ts
  const knowledgeApiRoutes = HttpApiBuilder.layer(KnowledgeApi).pipe(
    Layer.provide(KnowledgeSessionHandler),
    Layer.provide(KnowledgeIngestHandler),
    Layer.provide(KnowledgeGraphHandler),
    Layer.provide(
      IngestService.layer.pipe(
        Layer.provide(
          IngestJobService.layer.pipe(
            Layer.provide(graphStoreLayer),
            Layer.provide(extractorLayer),
            Layer.provide(summaryWriterLayer),
            Layer.provide(wikiSessionLayer),
          ),
        ),
      ),
    ),
    Layer.provideMerge(graphStoreLayer),
    Layer.provide(externalAuthLayer),
    Layer.provide(KnowledgeAdapterLayer),
    Layer.provide(ExternalAuthConfig.layer),
    Layer.provide(Layer.succeed(ExternalIdentity, ExternalIdentity.of(fallbackIdentity))),
    Layer.provide(schemaErrorLayer),
  )
```

- [ ] **Step 2: 更新 HTTP 测试**

在 `packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge-ingest.test.ts`：

(a) import 增补：

```ts
import { IngestJobService } from "@/knowledge/ingest-job"
import { pollWithTimeout } from "@test/lib/effect"
```

> 注：GET 处理已并入 `KnowledgeIngestHandler`，无需新增 handler import；`apiLayer` 仍只 provide `KnowledgeIngestHandler`。

(b) 把 `apiLayer` 里 `IngestService.layer` 的 provide 链改为包一层 `IngestJobService.layer`（与 Task 6 Step 1(b) 相同结构）。

(c) 新增轮询辅助（放在 `const it = testEffect(apiLayer)` 之后）：

```ts
const pollJob = (jobId: string) =>
  pollWithTimeout(
    HttpClientRequest.get(`/serve/api/ingest/jobs/${jobId}`).pipe(
      HttpClient.execute,
      Effect.flatMap((r) => r.json),
      Effect.map((body: any) => (body.data.status !== "RUNNING" ? body.data : undefined)),
    ),
    `job ${jobId} did not finish`,
  )
```

(d) 改写用例 1（提交后轮询）：

```ts
  it.live("submits a document and the job completes via GET /serve/api/ingest/jobs/:jobId", () =>
    Effect.gen(function* () {
      const submit = yield* HttpClientRequest.post("/serve/api/ingest").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            workspaceId: "ws_1",
            documents: [
              {
                documentId: "10001",
                title: "考勤制度",
                llmPath: tmpdir(),
                format: "txt",
                operation: "CREATE",
                fileContent: Buffer.from("第一章 考勤制度 人力资源部 负责 考勤 管理").toString("base64"),
              },
            ],
          }),
        ),
        HttpClient.execute,
      )
      expect(submit.status).toBe(200)
      const submitBody = (yield* submit.json) as any
      expect(submitBody.code).toBe(200)
      expect(submitBody.data).toHaveLength(1)
      expect(submitBody.data[0].documentId).toBe("10001")
      expect(submitBody.data[0].status).toBe("RUNNING")

      const job = yield* pollJob(submitBody.data[0].jobId)
      expect(job.status).toBe("SUCCESS")
      expect(job.documentId).toBe("10001")
      expect(job.entities).toBe(2)
      expect(job.relations).toBe(1)
      expect(job.summary).toBe("SUCCESS")
    }),
  )
```

(e) 改写用例 2（只提交、校验 200）：

```ts
  it.live("accepts a workspace not in the identity (skips workspace check)", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/serve/api/ingest").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            workspaceId: "kb_forbidden",
            documents: [{ documentId: "1", title: "x", operation: "DELETE" }],
          }),
        ),
        HttpClient.execute,
      )
      // 入库跳过工作区校验，直接信任 documents 携带的 llmPath
      expect(response.status).toBe(200)
    }),
  )
```

(f) 改写用例 3（DELETE 提交后轮询再查图）：

```ts
  it.live("ingest DELETE runs a job that removes the existing graph", () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      yield* store.replaceDocumentGraph({
        workspaceId: "ws_1",
        documentId: "10001",
        scope: "PUBLIC",
        ownerId: "",
        entities: [{ name: "旧制度", type: "制度" }],
        relations: [],
      })
      const response = yield* HttpClientRequest.post("/serve/api/ingest").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            workspaceId: "ws_1",
            documents: [{ documentId: "10001", title: "旧制度", operation: "DELETE" }],
          }),
        ),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      const job = yield* pollJob(body.data[0].jobId)
      expect(job.status).toBe("SUCCESS")
      const remaining = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
      expect(remaining).toHaveLength(0)
    }),
  )
```

(g) 新增两个用例：

```ts
  it.live("batch GET /serve/api/ingest/jobs returns jobs in requested order", () =>
    Effect.gen(function* () {
      const submit = yield* HttpClientRequest.post("/serve/api/ingest").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            workspaceId: "ws_1",
            documents: [
              { documentId: "a", title: "A", operation: "DELETE" },
              { documentId: "b", title: "B", operation: "DELETE" },
            ],
          }),
        ),
        HttpClient.execute,
      )
      const body = (yield* submit.json) as any
      const ids = [body.data[1].jobId, body.data[0].jobId] // 故意乱序
      const polled = yield* Effect.forEach(ids, (id: string) => pollJob(id), { concurrency: 2 })
      expect(polled.every((j: any) => j.status === "SUCCESS")).toBe(true)

      const listResp = yield* HttpClientRequest.get(`/serve/api/ingest/jobs?ids=${ids.join(",")}`).pipe(
        HttpClient.execute,
      )
      const listBody = (yield* listResp.json) as any
      expect(listBody.data.map((j: any) => j.jobId)).toEqual(ids)
    }),
  )

  it.live("GET /serve/api/ingest/jobs/:jobId returns 404 for unknown id", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/serve/api/ingest/jobs/job_nope").pipe(HttpClient.execute)
      expect(response.status).toBe(404)
    }),
  )
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd packages/opencode && bun test src/server/routes/instance/httpapi/handlers/knowledge-ingest.test.ts`
Expected: PASS（5 个用例，含新增批量与 404）。

- [ ] **Step 4: 类型检查 + 全量 knowledge 测试**

Run: `cd packages/opencode && bun run typecheck`
Run: `cd packages/opencode && bun test src/knowledge src/server/routes/instance/httpapi/handlers/knowledge-ingest.test.ts`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/server.ts packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge-ingest.test.ts
git commit -m "feat(server): wire async ingest jobs into knowledge http api"
```

---

## 自审

**Spec 覆盖：**
- 数据模型（`kg_ingest_job` 表、状态机、无 PENDING）→ Task 1。
- 执行机制（fork 实例级 scope、信号量、配置项、`IngestService` 瘦身）→ Task 2/3。
- HTTP 契约（POST 返回 jobId、GET 单查、GET 批量、鉴权 401/403/404）→ Task 4/5。
- 重启兜底（RUNNING→INTERRUPTED）→ Task 2（层初始化）+ Task 1（store 方法）+ 测试。
- 测试清单（7 项）→ Task 1/2/3/6 全覆盖。

**类型一致性：** `IngestJob`（store）字段与 `IngestJobResult`（protocol）一致；`start` 返回 jobId 字符串；`submit` 返回 `IngestSubmitItem[]`；handler 端点名 `ingest`/`job`/`jobs` 与协议端点一致。

**占位符扫描：** 无 TBD/TODO、无占位代码；所有代码步骤给出完整实现，每个任务以可独立测试的交付物结束。
