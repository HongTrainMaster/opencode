import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { readFileSync } from "node:fs"
import { PptGenService } from "@/knowledge/ppt-gen"
import { PptCoverService } from "@/knowledge/ppt-cover"
import { PptJobService } from "@/knowledge/ppt-job"
import type { PptJobWithProgress } from "@/knowledge/ppt-job"
import { KnowledgeApi } from "../groups/knowledge"

/** taskId 由业务端（Java 雪花ID）生成，仅允许安全文件名字符，防止路径穿越逃逸工作区 */
const TASK_ID_RE = /^[A-Za-z0-9._-]+$/

/** 契约字段 jobId = 库表 PptJobRow.id */
const toJobResult = (row: PptJobWithProgress) => ({
  jobId: row.id,
  taskId: row.taskId,
  status: row.status,
  outputPath: row.outputPath ?? undefined,
  error: row.error ?? undefined,
  progress: row.progress,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export const PptGenHandler = HttpApiBuilder.group(
  KnowledgeApi,
  "knowledge.ppt",
  (handlers) =>
    Effect.gen(function* () {
      const pptGen = yield* PptGenService
      const coverService = yield* PptCoverService
      const jobService = yield* PptJobService
      return handlers
        .handle(
          "gen",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            const taskId: string = ctx.payload?.taskId ?? ""
            const prompt: string = ctx.payload?.prompt ?? ""
            const style = ctx.payload?.style ?? {}

            if (!identity.userId) {
              yield* Effect.logWarning("ppt gen rejected 401", { taskId, reason: "no userId" })
              return HttpServerResponse.empty({ status: 401 })
            }
            if (!taskId || !prompt || !style.fileName || !style.fileContent) {
              yield* Effect.logWarning("ppt gen rejected 400", { taskId })
              return HttpServerResponse.empty({ status: 400 })
            }
            if (!TASK_ID_RE.test(taskId)) {
              yield* Effect.logWarning("ppt gen rejected 400", { taskId, reason: "invalid taskId" })
              return HttpServerResponse.empty({ status: 400 })
            }

            const jobId = yield* jobService.start({
              taskId,
              prompt,
              run: pptGen.gen({
                taskId,
                prompt,
                styleFileName: style.fileName,
                styleContentBase64: style.fileContent,
              }).pipe(
                Effect.map((r) => {
                  if (r.status !== "SUCCESS" || !r.outputPath) {
                    throw new Error(r.error ?? "ppt gen failed without error")
                  }
                  return { outputPath: r.outputPath }
                }),
              ),
            })
            yield* Effect.logInfo("ppt gen submitted", { taskId, jobId })
            return { code: 200, data: [{ taskId, jobId, status: "RUNNING" }] }
          }),
        )
        .handle(
          "renderCover",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            const taskId: string = ctx.payload?.taskId ?? ""
            const style = ctx.payload?.style ?? {}

            if (!identity.userId) {
              yield* Effect.logWarning("ppt cover rejected 401", { taskId, reason: "no userId" })
              return HttpServerResponse.empty({ status: 401 })
            }
            if (!taskId || !style.fileName || !style.fileContent) {
              yield* Effect.logWarning("ppt cover rejected 400", { taskId })
              return HttpServerResponse.empty({ status: 400 })
            }
            if (!TASK_ID_RE.test(taskId)) {
              yield* Effect.logWarning("ppt cover rejected 400", { taskId, reason: "invalid taskId" })
              return HttpServerResponse.empty({ status: 400 })
            }

            const jobId = yield* jobService.start({
              taskId,
              prompt: "ppt cover render",
              run: coverService.render({
                taskId,
                styleFileName: style.fileName,
                styleContentBase64: style.fileContent,
              }).pipe(
                Effect.map((r) => {
                  if (r.status !== "SUCCESS" || !r.outputPath) {
                    throw new Error(r.error ?? "ppt cover failed without error")
                  }
                  return { outputPath: r.outputPath }
                }),
              ),
            })
            yield* Effect.logInfo("ppt cover submitted", { taskId, jobId })
            return { code: 200, data: [{ taskId, jobId, status: "RUNNING" }] }
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
        .handleRaw(
          "file",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const job = yield* jobService.get(ctx.params.jobId)
            if (!job) return HttpServerResponse.empty({ status: 404 })
            const outputPath = job.outputPath
            if (job.status !== "SUCCESS" || !outputPath) {
              return HttpServerResponse.empty({ status: 409 }) // 未就绪
            }
            return yield* Effect.try({
              try: () => readFileSync(outputPath) as unknown as Uint8Array,
              catch: () => new Error("output file unreadable"),
            }).pipe(
              Effect.match({
                onFailure: () => HttpServerResponse.empty({ status: 500 }),
                onSuccess: (bytes) => {
                  // 该端点同时服务 .pptx（gen）与 .png（cover），content-type 按扩展名区分
                  const contentType = outputPath.endsWith(".png")
                    ? "image/png"
                    : "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                  return HttpServerResponse.uint8Array(bytes, { contentType })
                },
              }),
            )
          }),
        )
    }),
)
