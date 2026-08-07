import { Context, Effect, Exit, Layer, Scope } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ascending } from "@/id/id"
import { pptRoot } from "./ppt-gen"
import { KnowledgeGraphStore, type PptJobRow } from "./store"

/** PPT 生成进度（与 protocol PptJobProgress 一致，读 output/progress.json 解析） */
export interface PptJobProgress {
  stage?: string
  totalSlides?: number
  totalPages?: number
  pagesDone?: number
  imagesTotal?: number
  imagesDone?: number
  currentImage?: string
}

/** PptJobRow + 尽力而为的进度字段 */
export type PptJobWithProgress = PptJobRow & { progress?: PptJobProgress }

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
  readonly get: (jobId: string) => Effect.Effect<PptJobWithProgress | undefined>
  readonly list: (jobIds: string[]) => Effect.Effect<PptJobWithProgress[]>
}

/** 读取任务工作目录下 output/progress.json；文件缺失/解析失败返回 undefined（尽力而为） */
function readProgress(taskId: string): PptJobProgress | undefined {
  const path = join(pptRoot(), taskId, "output", "progress.json")
  try {
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as PptJobProgress) : undefined
  } catch {
    return undefined
  }
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
        get: (jobId) =>
          Effect.gen(function* () {
            const row = yield* store.getPptJob(jobId)
            if (!row) return undefined
            return { ...row, progress: readProgress(row.taskId) }
          }),
        list: (jobIds) =>
          Effect.gen(function* () {
            const rows = yield* store.listPptJobs(jobIds)
            return rows.map((row) => ({ ...row, progress: readProgress(row.taskId) }))
          }),
      })
    }),
  )
}
