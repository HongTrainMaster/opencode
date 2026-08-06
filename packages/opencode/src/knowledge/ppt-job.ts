import { Context, Effect, Exit, Layer, Scope } from "effect"
import { ascending } from "@/id/id"
import { KnowledgeGraphStore, type PptJobRow } from "./store"

export interface PptJobRunSuccess {
  /** 产物 .pptx 的绝对路径 */
  outputPath: string
}

export interface StartPptJobInput {
  taskId: string
  prompt: string
  run: Effect.Effect<PptJobRunSuccess, Error>
}

export interface PptJobServiceShape {
  readonly start: (input: StartPptJobInput) => Effect.Effect<string>
  readonly get: (jobId: string) => Effect.Effect<PptJobRow | undefined>
  readonly list: (jobIds: string[]) => Effect.Effect<PptJobRow[]>
}

export class PptJobService extends Context.Service<PptJobService, PptJobServiceShape>()(
  "@opencode/knowledge/PptJob",
) {
  static layer = Layer.effect(
    PptJobService,
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      // 实例级 scope：fork 的后台任务在请求返回后继续执行，生命周期与 BackgroundJob 一致。
      const scope = Scope.makeUnsafe("sequential")

      // 重启兜底：遗留 RUNNING 记录（崩溃进程残留）标记 INTERRUPTED，业务端轮询到后可重新提交
      yield* store.interruptRunningPptJobs()

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Scope.closeUnsafe(scope, Exit.void)
        }),
      )

      const finish = Effect.fn("PptJob.finish")(function* (input: StartPptJobInput, jobId: string) {
        const outcome = yield* Effect.result(input.run)
        if (outcome._tag === "Failure") {
          const error = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
          yield* store.updatePptJob({ id: jobId, status: "FAILED", error })
        } else {
          yield* store.updatePptJob({
            id: jobId,
            status: "SUCCESS",
            outputPath: outcome.success.outputPath,
          })
        }
      })

      return PptJobService.of({
        start: (input) =>
          Effect.gen(function* () {
            const jobId = ascending("job")
            yield* store.insertPptJob({
              id: jobId,
              taskId: input.taskId,
              prompt: input.prompt,
              status: "RUNNING",
            })
            yield* Effect.forkIn(finish(input, jobId), scope).pipe(Effect.asVoid)
            return jobId
          }),
        get: (jobId) => store.getPptJob(jobId),
        list: (jobIds) => store.listPptJobs(jobIds),
      })
    }),
  )
}
