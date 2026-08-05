import { Context, Effect, Exit, Layer, Scope } from "effect"
import { ascending } from "@/id/id"
import { KnowledgeGraphStore, type IngestJobRow } from "./store"

/** 任务状态（与 kg_ingest_job.status 一致） */
export type IngestJobStatus = "RUNNING" | "SUCCESS" | "FAILED" | "INTERRUPTED"

export interface IngestJobMeta {
  documentId: string
  workspaceId: string
  operation: "CREATE" | "UPDATE" | "DELETE"
}

export interface StartIngestJobInput extends IngestJobMeta {
  /** 完整入库管线（解析→抽实体→写图→wiki）。DELETE 分支由管线内部处理。 */
  readonly run: Effect.Effect<
    { entities: number; relations: number; summary: "SUCCESS" | "SKIPPED" | null },
    Error
  >
}

export interface IngestJobServiceShape {
  readonly start: (input: StartIngestJobInput) => Effect.Effect<string>
  readonly get: (jobId: string) => Effect.Effect<IngestJobRow | undefined>
  readonly list: (jobIds: string[]) => Effect.Effect<IngestJobRow[]>
}

type RunSuccess = { entities: number; relations: number; summary: "SUCCESS" | "SKIPPED" | null }

export class IngestJobService extends Context.Service<IngestJobService, IngestJobServiceShape>()(
  "@opencode/knowledge/IngestJob",
) {
  static layer = Layer.effect(
    IngestJobService,
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      // 实例级 scope：fork 的后台任务在请求返回后继续执行，生命周期与 BackgroundJob 一致。
      // 用 makeUnsafe 同步创建（layer 构建时无外部 Scope），实例销毁时关闭。
      const scope = Scope.makeUnsafe("sequential")

      // 重启兜底：遗留 RUNNING 记录（崩溃进程残留）标记 INTERRUPTED，业务端轮询到后可重新提交
      yield* store.interruptRunningIngestJobs()

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Scope.closeUnsafe(scope, Exit.void)
        }),
      )

      const finish = Effect.fn("IngestJob.finish")(function* (input: StartIngestJobInput, jobId: string) {
        const outcome = yield* Effect.result(input.run)
        if (outcome._tag === "Failure") {
          const error = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
          yield* store.updateIngestJob({ id: jobId, status: "FAILED", error })
        } else {
          yield* store.updateIngestJob({
            id: jobId,
            status: "SUCCESS",
            entities: outcome.success.entities,
            relations: outcome.success.relations,
            summary: outcome.success.summary ?? null,
          })
        }
      })

      return IngestJobService.of({
        start: (input) =>
          Effect.gen(function* () {
            const jobId = ascending("job")
            yield* store.insertIngestJob({
              id: jobId,
              documentId: input.documentId,
              workspaceId: input.workspaceId,
              operation: input.operation,
              status: "RUNNING",
            })
            yield* Effect.forkIn(finish(input, jobId), scope).pipe(Effect.asVoid)
            return jobId
          }),
        get: (jobId) => store.getIngestJob(jobId),
        list: (jobIds) => store.listIngestJobs(jobIds),
      })
    }),
  )
}
