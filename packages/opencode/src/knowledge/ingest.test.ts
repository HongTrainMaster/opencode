import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { EntityExtractor, type ExtractedGraph } from "./entity-extractor"
import { IngestService } from "./ingest"
import { IngestJobService, type IngestJobServiceShape } from "./ingest-job"
import { KnowledgeGraphStore, type IngestJobRow } from "./store"
import { SummaryWriter } from "./summary-writer"
import { WikiSessionService } from "./wiki-session"
import { mkdtempSync, writeFileSync } from "node:fs"
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
const extractorLayer = EntityExtractor.test(({ title, text }) =>
  Effect.succeed({
    entities: [
      { name: title, type: "文档" },
      { name: "人力资源部", type: "角色" },
    ],
    relations: [{ head: title, tail: "人力资源部", relation: "负责" }],
  }),
)
const summaryWriterLayerNoop = SummaryWriter.test(tmpdir())

// Default wiki session mock: SUCCESS without invoking a real opencode session.
// 按新契约返回 sourcePath（指向一个真实存在的临时源页），供入库管线落盘 {documentId}.md。
const wikiSourcePage = (() => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-mock-"))
  const p = join(dir, "source.md")
  writeFileSync(p, "# 默认源页\n\n- 要点", "utf-8")
  return p
})()
const wikiSessionSuccessLayer = WikiSessionService.test(() =>
  Effect.succeed({ status: "SUCCESS" as const, sourcePath: wikiSourcePage }),
)

// 挂起的 wiki 会话：模拟模型调用永不返回 → 用于验证超时降级不会永久占用信号量/任务
const wikiSessionHangingLayer = WikiSessionService.test(() => Effect.never)

/** 轮询 job 直到终态（RUNNING/SUCCESS/FAILED/INTERRUPTED 中的终态为 SUCCESS/FAILED/INTERRUPTED） */
const pollUntilDone = (
  jobService: IngestJobServiceShape,
  jobId: string,
  attempts = 50,
): Effect.Effect<IngestJobRow> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const job = yield* jobService.get(jobId)
      if (job && job.status !== "RUNNING") return job
      yield* Effect.sleep("10 millis")
    }
    throw new Error("timed out waiting for ingest job")
  })

const run = <A>(
  effect: Effect.Effect<A, unknown, IngestService | KnowledgeGraphStore | IngestJobService>,
  writerLayer: Layer.Layer<SummaryWriter> = summaryWriterLayerNoop,
  wikiLayer: Layer.Layer<WikiSessionService> = wikiSessionSuccessLayer,
  extractor: Layer.Layer<EntityExtractor> = extractorLayer,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(IngestService.layer),
      Effect.provide(IngestJobService.layer),
      Effect.provide(extractor),
      Effect.provide(storeLayer),
      Effect.provide(writerLayer),
      Effect.provide(wikiLayer),
    ),
  )

describe("IngestService", () => {
  it("submits CREATE as a job and resolves to SUCCESS with graph written", async () => {
    const { item, job, entities } = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const jobService = yield* IngestJobService
        const store = yield* KnowledgeGraphStore
        const items = yield* svc.ingest({
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
        const item = items[0]!
        // 提交立即返回，状态为 RUNNING
        expect(item.status).toBe("RUNNING")
        expect(item.jobId).toBeTruthy()
        const job = yield* pollUntilDone(jobService, item.jobId)
        const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        return { item, job, entities }
      }),
    )
    expect(job.status).toBe("SUCCESS")
    expect(job.entities).toBe(2)
    expect(job.relations).toBe(1)
    expect(entities).toHaveLength(2)
  })

  it("DELETE resolves to SUCCESS and removes the graph", async () => {
    const { job, entities } = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const jobService = yield* IngestJobService
        const store = yield* KnowledgeGraphStore
        const createItems = yield* svc.ingest({
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
        // 等 CREATE job 完成后 DELETE，避免并发写同一文档图
        yield* pollUntilDone(jobService, createItems[0]!.jobId)
        const items = yield* svc.ingest({
          workspaceId: "kb_1",
          identity,
          documents: [{ documentId: "10001", title: "考勤制度", operation: "DELETE" }],
        })
        const job = yield* pollUntilDone(jobService, items[0]!.jobId)
        const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        return { job, entities }
      }),
    )
    expect(job.status).toBe("SUCCESS")
    expect(entities).toHaveLength(0)
  })

  it("ingests to a workspace not listed in identity (skips workspace check)", async () => {
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const jobService = yield* IngestJobService
        const items = yield* svc.ingest({
          workspaceId: "kb_other",
          identity,
          documents: [{ documentId: "1", title: "x", operation: "DELETE" }],
        })
        return yield* pollUntilDone(jobService, items[0]!.jobId)
      }),
    )
    expect(results.status).toBe("SUCCESS")
  })

  it("allows own personal workspace even if not listed", async () => {
    const { job, entities } = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const jobService = yield* IngestJobService
        const store = yield* KnowledgeGraphStore
        const items = yield* svc.ingest({
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
        const job = yield* pollUntilDone(jobService, items[0]!.jobId)
        const entities = yield* store.listEntitiesByDocument({ documentId: "20001", userId: "user_1" })
        return { job, entities }
      }),
    )
    expect(job.status).toBe("SUCCESS")
    expect(entities).toHaveLength(2)
  })

  it("runs wiki session to build pages and persists summary as {documentId}.md", async () => {
    let called: { workspaceLlmPath: string; documentId: string; title: string } | undefined
    const writerDir = mkdtempSync(join(tmpdir(), "kg-summary-"))
    const sourceDir = mkdtempSync(join(tmpdir(), "wiki-mock-"))
    const sourceFile = join(sourceDir, "source.md")
    writeFileSync(sourceFile, "# 考勤制度\n\n## 核心观点\n\n- 要点一", "utf-8")
    const wikiLayer = WikiSessionService.test((args) => {
      called = { workspaceLlmPath: args.workspaceLlmPath, documentId: args.documentId, title: args.title }
      return Effect.succeed({ status: "SUCCESS" as const, sourcePath: sourceFile })
    })
    try {
      const job = await run(
        Effect.gen(function* () {
          const svc = yield* IngestService
          const jobService = yield* IngestJobService
          const items = yield* svc.ingest({
            workspaceId: "kb_1",
            identity,
            documents: [{
              documentId: "10001",
              title: "考勤制度",
              llmPath: writerDir,
              format: "txt",
              operation: "CREATE",
              fileContent: Buffer.from("第一章 考勤制度 人力资源部 负责 考勤 管理").toString("base64"),
            }],
          })
          return yield* pollUntilDone(jobService, items[0]!.jobId)
        }),
        SummaryWriter.test(writerDir),
        wikiLayer,
      )
      expect(job.status).toBe("SUCCESS")
      expect(job.summary).toBe("SUCCESS")
      expect(called).toBeDefined()
      expect(called!.documentId).toBe("10001")
      expect(called!.title).toBe("考勤制度")
      // 根因1(a)：LLM 源页正文已以 {documentId}.md 落盘，供 /serve/api/summary 读取
      const persisted = await readFile(join(writerDir, "wiki", "sources", "10001.md"), "utf-8")
      expect(persisted).toContain("核心观点")
      expect(persisted).toContain("type: summary")
    } finally {
      await rm(writerDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it("marks summary SKIPPED when wiki session reports SUCCESS but writes no source page", async () => {
    const wikiLayer = WikiSessionService.test(() =>
      Effect.succeed({ status: "SUCCESS" as const }),
    )
    const job = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const jobService = yield* IngestJobService
        const items = yield* svc.ingest({
          workspaceId: "kb_1",
          identity,
          documents: [{
            documentId: "10001",
            title: "考勤制度",
            llmPath: join(tmpdir(), "kg-ingest-test", "kb_1"),
            format: "txt",
            operation: "CREATE",
            fileContent: Buffer.from("正文").toString("base64"),
          }],
        })
        return yield* pollUntilDone(jobService, items[0]!.jobId)
      }),
      summaryWriterLayerNoop,
      wikiLayer,
    )
    expect(job.status).toBe("SUCCESS")
    expect(job.summary).toBe("SKIPPED")
  })

  it("skips summary when workspace has no llmPath", async () => {
    const job = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const jobService = yield* IngestJobService
        const items = yield* svc.ingest({
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
        return yield* pollUntilDone(jobService, items[0]!.jobId)
      }),
    )
    expect(job.status).toBe("SUCCESS")
    expect(job.summary).toBeNull()
  })

  it("deletes source page on DELETE operation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-ingest-"))
    try {
      await run(
        Effect.gen(function* () {
          const svc = yield* IngestService
          const jobService = yield* IngestJobService
          const createItems = yield* svc.ingest({
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
          yield* pollUntilDone(jobService, createItems[0]!.jobId)
          const items = yield* svc.ingest({
            workspaceId: "kb_1",
            identity,
            documents: [{ documentId: "10001", title: "考勤制度", llmPath: dir, operation: "DELETE" }],
          })
          yield* pollUntilDone(jobService, items[0]!.jobId)
        }),
        SummaryWriter.test(dir),
      )
      // DELETE still goes through summaryWriter.delete; with no prior file written
      // the delete is a no-op (ENOENT ignored), so the file must not exist.
      const exists = await access(join(dir, "wiki", "sources", "10001.md")).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("FAILED job records error when extractor throws", async () => {
    const failingExtractorLayer = EntityExtractor.test(
      () => Effect.fail(new Error("extract exploded")) as unknown as Effect.Effect<ExtractedGraph>,
    )
    const job = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const jobService = yield* IngestJobService
        const items = yield* svc.ingest({
          workspaceId: "kb_1",
          identity,
          documents: [
            {
              documentId: "999",
              title: "坏文档",
              format: "txt",
              operation: "CREATE",
              fileContent: Buffer.from("正文").toString("base64"),
            },
          ],
        })
        return yield* pollUntilDone(jobService, items[0]!.jobId)
      }),
      summaryWriterLayerNoop,
      wikiSessionSuccessLayer,
      failingExtractorLayer,
    )
    expect(job.status).toBe("FAILED")
    expect(job.error).toContain("extract exploded")
  })

  it("times out a hanging wiki session and degrades to SKIPPED (no permanent hang)", async () => {
    const prev = process.env.KNOWLEDGE_INGEST_WIKI_TIMEOUT_MS
    process.env.KNOWLEDGE_INGEST_WIKI_TIMEOUT_MS = "100" // 100ms 超时
    try {
      const { job, store } = await run(
        Effect.gen(function* () {
          const svc = yield* IngestService
          const jobService = yield* IngestJobService
          const kg = yield* KnowledgeGraphStore
          const items = yield* svc.ingest({
            workspaceId: "kb_1",
            identity,
            documents: [
              {
                documentId: "timeout_doc",
                title: "超时文档",
                format: "txt",
                llmPath: tmpdir(),
                operation: "CREATE",
                fileContent: Buffer.from("超时测试正文 人力资源部 负责 考勤").toString("base64"),
              },
            ],
          })
          const job = yield* pollUntilDone(jobService, items[0]!.jobId)
          return { job, store: kg }
        }),
        summaryWriterLayerNoop,
        wikiSessionHangingLayer, // 挂起 → 触发 100ms 超时
      )
      // 超时后任务必须有终态（不再是 RUNNING 挂死），且摘要降级为 SKIPPED
      expect(job.status).not.toBe("RUNNING")
      expect(job.summary).toBe("SKIPPED")
      // 图谱（实体）在 summary 前已写入
      const entities = await Effect.runPromise(
        store.listEntitiesByDocument({ documentId: "timeout_doc", userId: "user_1" }),
      )
      expect(entities.length).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env.KNOWLEDGE_INGEST_WIKI_TIMEOUT_MS
      else process.env.KNOWLEDGE_INGEST_WIKI_TIMEOUT_MS = prev
    }
  }, 20000)

  it("dedups: skips creating a duplicate job for a document with an active RUNNING job", async () => {
    const prev = process.env.KNOWLEDGE_INGEST_WIKI_TIMEOUT_MS
    delete process.env.KNOWLEDGE_INGEST_WIKI_TIMEOUT_MS // 本测试关闭超时，让挂起任务保持 RUNNING
    try {
      const result = await run(
        Effect.gen(function* () {
          const svc = yield* IngestService
          const jobService = yield* IngestJobService
          const doc = {
            documentId: "dedup_doc",
            title: "去重文档",
            format: "txt",
            llmPath: tmpdir(),
            operation: "CREATE" as const,
            fileContent: Buffer.from("去重测试正文 人力资源部 负责 考勤").toString("base64"),
          }
          // 第一次提交：挂起 wiki → 任务保持 RUNNING
          const first = yield* svc.ingest({ workspaceId: "kb_1", identity, documents: [doc] })
          // 第二次提交同一文档：应被去重，不产生新 job
          const second = yield* svc.ingest({ workspaceId: "kb_1", identity, documents: [doc] })
          return { first: first.length, second: second.length }
        }),
        summaryWriterLayerNoop,
        wikiSessionHangingLayer,
      )
      // 第一次返回 1 个 job；第二次（同文档 RUNNING 中）应返回 0 个
      expect(result.first).toBe(1)
      expect(result.second).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.KNOWLEDGE_INGEST_WIKI_TIMEOUT_MS
      else process.env.KNOWLEDGE_INGEST_WIKI_TIMEOUT_MS = prev
    }
  }, 20000)
})
