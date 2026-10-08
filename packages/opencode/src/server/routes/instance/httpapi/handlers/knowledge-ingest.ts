import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { IngestService } from "@/knowledge/ingest"
import { IngestJobService } from "@/knowledge/ingest-job"
import type { IngestJobRow } from "@/knowledge/store"
import { KnowledgeApi } from "../groups/knowledge"

/** 协议契约字段 jobId = 库表 IngestJobRow.id；summary 收窄为字面量 union */
const toJobResult = (row: IngestJobRow) => ({
  jobId: row.id,
  documentId: row.documentId,
  workspaceId: row.workspaceId,
  operation: row.operation,
  status: row.status,
  entities: row.entities,
  relations: row.relations,
  summary: (row.summary === "SUCCESS" || row.summary === "SKIPPED" ? row.summary : undefined) as
    | "SUCCESS"
    | "SKIPPED"
    | undefined,
  error: row.error ?? undefined,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export const KnowledgeIngestHandler = HttpApiBuilder.group(
  KnowledgeApi,
  "knowledge.ingest",
  (handlers) =>
    Effect.gen(function* () {
      const ingest = yield* IngestService
      const jobService = yield* IngestJobService
      return handlers
        .handle(
          "ingest",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            const workspaceId: string = ctx.payload?.workspaceId ?? ""
            const documentCount: number = ctx.payload?.documents?.length ?? 0

            yield* Effect.logInfo("knowledge ingest entry", {
              workspaceId,
              documentCount,
              authenticated: identity.userId !== "",
              userId: identity.userId || "",
              tenantId: identity.tenantId || "",
            })

            if (!identity.userId) {
              yield* Effect.logWarning("knowledge ingest rejected 401", {
                workspaceId,
                documentCount,
                reason: "external identity has no userId (token missing or invalid)",
              })
              return HttpServerResponse.empty({ status: 401 })
            }
            const data = yield* ingest
              .ingest({
                workspaceId,
                identity,
                documents: ctx.payload.documents,
              })
              .pipe(
                // 提交阶段失败此前要么变 500 无上下文、要么被 catchTag 吞成 403；先留日志再走原错误流
                // console 而非 Effect.log：生产 journald 只收得到 console.*
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    console.error(
                      `[knowledge-ingest] submit failed workspaceId=${workspaceId} documentCount=${documentCount} ` +
                        `userId=${identity.userId} tag=${(error as { _tag?: string })._tag ?? "?"}: ` +
                        (error instanceof Error ? error.message : String(error)),
                    )
                  }),
                ),
                Effect.catchTag("IngestForbiddenError", () => Effect.succeed(null)),
              )
            if (data === null) return HttpServerResponse.empty({ status: 403 })
            return { code: 200, data }
          }),
        )
        .handle(
          "job",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const job = yield* jobService.get(ctx.params.jobId)
            if (!job) return HttpServerResponse.empty({ status: 404 })
            return { code: 200, data: toJobResult(job) }
          }),
        )
        .handle(
          "jobs",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const ids = String(ctx.query.ids ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
            const jobs = yield* jobService.list(ids)
            return { code: 200, data: jobs.map(toJobResult) }
          }),
        )
    }),
)
