import { Context, Duration, Effect, Layer, Schema, Semaphore } from "effect"
import { readFile } from "node:fs/promises"
import type { ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { parseDocument } from "./doc-parser"
import { EntityExtractor } from "./entity-extractor"
import { IngestJobService } from "./ingest-job"
import { KnowledgeGraphStore } from "./store"
import { SummaryWriter } from "./summary-writer"
import { WikiSessionService } from "./wiki-session"

export class IngestForbiddenError extends Schema.TaggedErrorClass<IngestForbiddenError>()(
  "IngestForbiddenError",
  { message: Schema.String },
) {}

/** 去掉 llm-wiki 源页开头的 YAML frontmatter，只保留正文（SummaryWriter 会补自己的 frontmatter） */
function stripFrontmatter(markdown: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return m ? markdown.slice(m[0].length).trim() : markdown.trim()
}

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
  readonly ingest: (args: {
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
      const store = yield* KnowledgeGraphStore
      const extractor = yield* EntityExtractor
      const summaryWriter = yield* SummaryWriter
      const wikiSession = yield* WikiSessionService
      const jobService = yield* IngestJobService

      // wiki 会话并发上限（仅 wikiSession.build 过信号量，快速图操作不限）：
      // 防止多个提交请求叠加打爆 LLM。环境变量可调，默认 2。
      const wikiConcurrency = Number.parseInt(
        process.env.KNOWLEDGE_INGEST_WIKI_CONCURRENCY ?? "2",
        10,
      )
      const semaphore = yield* Semaphore.make(Math.max(1, Number.isFinite(wikiConcurrency) ? wikiConcurrency : 2))
      // wiki 会话（LLM 摘要）单任务超时：防止模型调用挂起导致信号量槽位被永久占用、
      // 后续所有文档的 summary 排队卡死。超时后任务标 SKIPPED（图谱/实体不受影响）。
      // 环境变量可调，默认 180 秒；0 = 不设超时。
      const wikiTimeoutMs = Number.parseInt(process.env.KNOWLEDGE_INGEST_WIKI_TIMEOUT_MS ?? "180000", 10)
      const wikiTimeout = Number.isFinite(wikiTimeoutMs) && wikiTimeoutMs > 0 ? Duration.millis(wikiTimeoutMs) : undefined

      return IngestService.of({
        ingest: (args) =>
          Effect.gen(function* () {
            const scope: "PUBLIC" | "PRIVATE" = args.workspaceId.startsWith("my_") ? "PRIVATE" : "PUBLIC"
            const ownerId = scope === "PRIVATE" ? args.identity.userId : ""

            yield* Effect.logInfo("knowledge ingest start", {
              workspaceId: args.workspaceId,
              scope,
              userId: args.identity.userId,
              documentCount: args.documents.length,
            })
            console.log(
              `[knowledge-ingest] start workspaceId=${args.workspaceId} scope=${scope} ` +
                `userId=${args.identity.userId} documents=${args.documents.length}`,
            )

            const runOne = (doc: IngestDocumentInput): Effect.Effect<
              { entities: number; relations: number; summary: "SUCCESS" | "SKIPPED" | null },
              Error
            > =>
              Effect.gen(function* () {
                if (doc.operation === "DELETE") {
                  const deleted = yield* store.deleteDocumentGraph({
                    workspaceId: args.workspaceId,
                    documentId: doc.documentId,
                  })
                  yield* Effect.logInfo("knowledge ingest delete done", {
                    documentId: doc.documentId,
                    workspaceId: args.workspaceId,
                    deletedEntities: deleted.deletedEntities,
                    deletedRelations: deleted.deletedRelations,
                  })
                  if (doc.llmPath) {
                    const deletedSummary = yield* Effect.result(
                      summaryWriter.delete({ workspaceLlmPath: doc.llmPath, documentId: doc.documentId }),
                    )
                    if (deletedSummary._tag === "Failure") {
                      // 只补日志：失败仍按原语义向上抛（任务 FAILED）
                      // console 而非 Effect.log：生产 journald 只收得到 console.*
                      console.warn(
                        `[knowledge-ingest] delete summary failed documentId=${doc.documentId} ` +
                          `llmPath=${doc.llmPath}: ` +
                          (deletedSummary.failure instanceof Error
                            ? deletedSummary.failure.message
                            : String(deletedSummary.failure)),
                      )
                      yield* Effect.fail(deletedSummary.failure)
                    }
                  }
                  return {
                    entities: deleted.deletedEntities,
                    relations: deleted.deletedRelations,
                    summary: doc.llmPath ? "SUCCESS" : null,
                  }
                }
                // 生产 journald 只收得到 console.*，关键轨迹用 console； Effect.log* 仅开发环境可见
                console.log(
                  `[knowledge-ingest] doc start documentId=${doc.documentId} operation=${doc.operation} ` +
                    `format=${doc.format ?? ""} fileContentLength=${doc.fileContent?.length ?? 0} ` +
                    `llmPath=${doc.llmPath ? "yes" : "no"}`,
                )
                const parsed = yield* parseDocument({ format: doc.format ?? "", fileContent: doc.fileContent })
                // 解析出空文本是最常见的"静默失败"：扫描件 OCR 缺工具、docx 结构异常、fileContent 为空
                // 都会一路"成功"到 0 实体 0 关系，业务侧表现为入库无效，这里必须显式留痕
                if (!parsed.text) {
                  console.warn(
                    `[knowledge-ingest] parsed to empty text documentId=${doc.documentId} ` +
                      `format=${doc.format ?? ""} fileContentLength=${doc.fileContent?.length ?? 0}`,
                  )
                } else {
                  console.log(`[knowledge-ingest] parse done documentId=${doc.documentId} textLength=${parsed.text.length}`)
                }
                const extracted = yield* extractor.extract({ title: doc.title, text: parsed.text })
                console.log(
                  `[knowledge-ingest] extract done documentId=${doc.documentId} ` +
                    `entities=${extracted.entities.length} relations=${extracted.relations.length}`,
                )
                yield* Effect.logInfo("knowledge ingest write graph", {
                  documentId: doc.documentId,
                  workspaceId: args.workspaceId,
                  scope,
                  ownerId,
                  title: doc.title,
                  entityCount: extracted.entities.length,
                  relationCount: extracted.relations.length,
                })
                const result = yield* store.replaceDocumentGraph({
                  workspaceId: args.workspaceId,
                  documentId: doc.documentId,
                  scope,
                  ownerId,
                  entities: extracted.entities,
                  relations: extracted.relations,
                })
                yield* Effect.logInfo("knowledge ingest write graph done", {
                  documentId: doc.documentId,
                  workspaceId: args.workspaceId,
                  entityCount: result.entityCount,
                  relationCount: result.relationCount,
                })
                let summary: "SUCCESS" | "SKIPPED" | null = null
                if (doc.llmPath) {
                  // wiki 会话是历史上最容易挂住的阶段：看到 summary start 而迟迟没有 job done 即挂起实锤
                  console.log(
                    `[knowledge-ingest] summary start documentId=${doc.documentId} workspaceLlmPath=${doc.llmPath}`,
                  )
                  yield* Effect.logInfo("knowledge summary start", {
                    documentId: doc.documentId,
                    workspaceId: args.workspaceId,
                    workspaceLlmPath: doc.llmPath,
                  })
                  // Build entity/source pages through a headless opencode session
                  // that runs the llm-wiki ingest workflow, so Q&A can find them.
                  // 带超时：模型调用挂起时不再永久占用信号量，超时降级 SKIPPED（图谱已完成）。
                  const wikiRun = semaphore.withPermits(1)(
                    wikiSession.build({
                      workspaceLlmPath: doc.llmPath,
                      documentId: doc.documentId,
                      title: doc.title,
                      text: parsed.text,
                    }),
                  )
                  const timed = wikiTimeout
                    ? yield* Effect.result(wikiRun.pipe(Effect.timeout(wikiTimeout)))
                    : yield* Effect.result(wikiRun)
                  let wikiResult: { status: "SUCCESS" | "SKIPPED"; sourcePath?: string; error?: string }
                  if (timed._tag === "Failure") {
                    const err = timed.failure instanceof Error ? timed.failure.message : String(timed.failure)
                    wikiResult = { status: "SKIPPED", error: `wiki session timed out or failed: ${err}` }
                    console.warn(
                      `[knowledge-ingest] summary skipped (timeout/failure) documentId=${doc.documentId} ` +
                        `llmPath=${doc.llmPath}: ${err}`,
                    )
                  } else {
                    wikiResult = timed.success
                  }
                  if (wikiResult.status === "SUCCESS" && wikiResult.sourcePath) {
                    // 根因1修复：llm-wiki 按"日期-标题"命名源页，业务端用 documentId 查不到。
                    // 把 LLM 生成的源页正文以 {documentId}.md 为名落盘，供 /serve/api/summary 读取。
                    const workspaceLlmPath = doc.llmPath
                    const persistOutcome = yield* Effect.result(
                      Effect.gen(function* () {
                        const raw = yield* Effect.tryPromise({
                          try: async () => readFile(wikiResult.sourcePath!, "utf-8"),
                          catch: (error) =>
                            new Error(`failed to read wiki source page: ${String(error)}`),
                        })
                        yield* summaryWriter.write({
                          workspaceLlmPath,
                          documentId: doc.documentId,
                          title: doc.title,
                          markdown: stripFrontmatter(raw),
                        })
                      }),
                    )
                    if (persistOutcome._tag === "Failure") {
                      summary = "SKIPPED"
                      console.warn(
                        `[knowledge-ingest] summary persist failed documentId=${doc.documentId} ` +
                          `sourcePath=${wikiResult.sourcePath}: ` +
                          (persistOutcome.failure instanceof Error
                            ? persistOutcome.failure.message
                            : String(persistOutcome.failure)),
                      )
                    } else {
                      summary = "SUCCESS"
                    }
                  } else {
                    summary = "SKIPPED"
                    console.warn(
                      `[knowledge-ingest] summary skipped documentId=${doc.documentId} ` +
                        `llmPath=${doc.llmPath}: ${wikiResult.error ?? "(no source page)"}`,
                    )
                  }
                } else {
                  yield* Effect.logDebug("knowledge summary skipped: no llmPath", {
                    documentId: doc.documentId,
                    workspaceId: args.workspaceId,
                  })
                }
                console.log(
                  `[knowledge-ingest] doc done documentId=${doc.documentId} ` +
                    `entities=${result.entityCount} relations=${result.relationCount} ` +
                    `summary=${summary ?? "none"}`,
                )
                return {
                  entities: result.entityCount,
                  relations: result.relationCount,
                  summary,
                }
              })

            const items: IngestSubmitItem[] = []
            for (const doc of args.documents) {
              // 同文档去重：若已有 RUNNING 活动任务（之前挂起的 summary 仍占位），跳过本次提交，
              // 避免现场每 30 分钟重发把信号量槽位越占越多、加重堵塞。返回该活动 job 状态。
              const active = yield* store.countActiveByDocument(doc.documentId)
              if (active > 0) {
                console.warn(
                  `[knowledge-ingest] dedup skip duplicate documentId=${doc.documentId} ` +
                    `workspaceId=${args.workspaceId} activeRunning=${active}`,
                )
                yield* Effect.logWarning("knowledge ingest dedup: skip duplicate", {
                  documentId: doc.documentId,
                  workspaceId: args.workspaceId,
                  activeRunning: active,
                })
                continue
              }
              const jobId = yield* jobService.start({
                documentId: doc.documentId,
                workspaceId: args.workspaceId,
                operation: doc.operation,
                run: runOne(doc),
              })
              items.push({ documentId: doc.documentId, jobId, status: "RUNNING" })
            }
            return items
          }),
      })
    }),
  )
}
