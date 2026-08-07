import { Context, Effect, Layer, Semaphore } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

export interface PptCoverRunResult {
  status: "SUCCESS" | "FAILED"
  /** status 为 SUCCESS 时封面 PNG 绝对路径 */
  outputPath?: string
  error?: string
}

export interface PptCoverServiceShape {
  readonly render: (args: {
    taskId: string
    styleFileName: string
    styleContentBase64: string
  }) => Effect.Effect<PptCoverRunResult>
}

export class PptCoverService extends Context.Service<PptCoverService, PptCoverServiceShape>()(
  "@opencode/knowledge/PptCover",
) {
  static layer = Layer.effect(
    PptCoverService,
    Effect.gen(function* () {
      // 并发上限：防多模板并发打爆 soffice（对齐 ingest 的 KNOWLEDGE_INGEST_WIKI_CONCURRENCY）
      const conc = Number(process.env.PPT_COVER_CONCURRENCY ?? "2")
      const semaphore = yield* Semaphore.make(Math.max(1, Number.isFinite(conc) ? conc : 2))
      return PptCoverService.of({
        render: (args) => semaphore.withPermits(1)(runPptCover(args)),
      })
    }),
  )

  static test = (render: PptCoverServiceShape["render"]) =>
    Layer.succeed(PptCoverService, PptCoverService.of({ render }))
}

/** 封面任务工作区根目录（服务端路径），可用环境变量覆盖 */
function coverRoot(): string {
  return process.env.PPT_COVER_ROOT ?? join(process.env.XDG_DATA_HOME ?? join(process.cwd(), ".opencode"), "ppt-cover")
}

/** 技能目录：优先环境变量，默认指向 fork 内置的 ppt-skill */
function skillDir(): string {
  return process.env.PPT_SKILL_DIR ?? join(import.meta.dir, "ppt-skill")
}

function runPptCover(args: {
  taskId: string
  styleFileName: string
  styleContentBase64: string
}): Effect.Effect<PptCoverRunResult> {
  return Effect.gen(function* () {
    yield* Effect.logInfo("ppt cover start", { taskId: args.taskId })

    // 任务隔离子目录：cover-root/{taskId}/
    const workdir = join(coverRoot(), args.taskId)
    yield* Effect.sync(() => mkdirSync(workdir, { recursive: true }))

    // 解码上传 .pptx 为 style.pptx（文件名固定，不取自上传文件名，防路径穿越）
    const stylePath = join(workdir, "style.pptx")
    yield* Effect.sync(() => {
      const buf = Buffer.from(args.styleContentBase64, "base64")
      if (buf.length === 0) throw new Error("style file content is empty")
      writeFileSync(stylePath, buf)
    })

    const coverPath = join(workdir, "cover.png")
    const script = join(skillDir(), "scripts", "render_cover.py")
    const r = yield* Effect.sync(() =>
      spawnSync("python3", [script, stylePath, coverPath], { encoding: "utf-8", timeout: 240_000 }),
    )
    if (r.status !== 0 || !existsSync(coverPath)) {
      const msg = `render_cover failed: ${(r.stderr ?? r.stdout ?? "").trim() || "no cover.png written"}`
      yield* Effect.logWarning("ppt cover failed", { taskId: args.taskId, error: msg })
      return { status: "FAILED" as const, error: msg }
    }
    yield* Effect.logInfo("ppt cover success", { taskId: args.taskId, outputPath: coverPath })
    return { status: "SUCCESS" as const, outputPath: coverPath }
  }).pipe(
    Effect.catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      return Effect.logError("ppt cover error", { taskId: args.taskId, error: msg }).pipe(
        Effect.as({ status: "FAILED" as const, error: msg }),
      )
    }),
  )
}
