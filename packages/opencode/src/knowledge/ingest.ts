import { Context, Effect, Layer, Schema, Semaphore } from "effect"
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
                    yield* summaryWriter.delete({ workspaceLlmPath: doc.llmPath, documentId: doc.documentId })
                  }
                  return {
                    entities: deleted.deletedEntities,
                    relations: deleted.deletedRelations,
                    summary: doc.llmPath ? "SUCCESS" : null,
                  }
                }
                const parsed = yield* parseDocument({ format: doc.format ?? "", fileContent: doc.fileContent })
                const extracted = yield* extractor.extract({ title: doc.title, text: parsed.text })
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
                  yield* Effect.logInfo("knowledge summary start", {
                    documentId: doc.documentId,
                    workspaceId: args.workspaceId,
                    workspaceLlmPath: doc.llmPath,
                  })
                  // Build entity/source pages through a headless opencode session
                  // that runs the llm-wiki ingest workflow, so Q&A can find them.
                  const wikiResult = yield* semaphore.withPermits(1)(
                    wikiSession.build({
                      workspaceLlmPath: doc.llmPath,
                      documentId: doc.documentId,
                      title: doc.title,
                      text: parsed.text,
                    }),
                  )
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
                      yield* Effect.logWarning("knowledge summary persist failed", {
                        documentId: doc.documentId,
                        workspaceId: args.workspaceId,
                        workspaceLlmPath: doc.llmPath,
                        sourcePath: wikiResult.sourcePath,
                        error:
                          persistOutcome.failure instanceof Error
                            ? persistOutcome.failure.message
                            : String(persistOutcome.failure),
                      })
                    } else {
                      summary = "SUCCESS"
                    }
                  } else {
                    summary = "SKIPPED"
                    yield* Effect.logWarning("knowledge summary skipped", {
                      documentId: doc.documentId,
                      workspaceId: args.workspaceId,
                      workspaceLlmPath: doc.llmPath,
                      error: wikiResult.error,
                    })
                  }
                } else {
                  yield* Effect.logDebug("knowledge summary skipped: no llmPath", {
                    documentId: doc.documentId,
                    workspaceId: args.workspaceId,
                  })
                }
                return {
                  entities: result.entityCount,
                  relations: result.relationCount,
                  summary,
                }
              })

            const items: IngestSubmitItem[] = []
            for (const doc of args.documents) {
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
